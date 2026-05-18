import { query, getClient } from '../config/database';
import type { Server } from 'socket.io';

export type ResolveConversationResult = {
  /** Canonical UUID (or unchanged id for non-direct chats) */
  conversationId: string;
  requestedId: string;
  resolvedFromLegacy: boolean;
  otherUserId: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuidConversationId = (id: string): boolean => UUID_RE.test(id);

/**
 * Resolve `direct_<userId>` to the UUID conversation row between two users.
 * Optionally creates a direct conversation when none exists (socket send flow).
 */
export const resolveConversationId = async (
  conversationId: string,
  userId: string,
  options?: { createDirectIfMissing?: boolean }
): Promise<ResolveConversationResult | null> => {
  if (!conversationId?.trim()) return null;

  const requestedId = conversationId.trim();

  if (!requestedId.startsWith('direct_')) {
    return {
      conversationId: requestedId,
      requestedId,
      resolvedFromLegacy: false,
      otherUserId: null,
    };
  }

  const extractedUserId = requestedId.replace('direct_', '');
  let otherUserId: string;

  if (extractedUserId === userId) {
    const otherMemberResult = await query(
      'SELECT user_id FROM conversation_members WHERE conversation_id::text = $1::text AND user_id != $2 LIMIT 1',
      [requestedId, userId]
    );
    if (otherMemberResult.rows.length === 0) {
      return null;
    }
    otherUserId = otherMemberResult.rows[0].user_id;
  } else {
    otherUserId = extractedUserId;
  }

  if (otherUserId === userId) {
    return null;
  }

  const existingConversation = await query(
    `SELECT CAST(c.id AS TEXT) as id
     FROM conversations c
     INNER JOIN conversation_members cm1 ON CAST(c.id AS TEXT) = CAST(cm1.conversation_id AS TEXT)
     INNER JOIN conversation_members cm2 ON CAST(c.id AS TEXT) = CAST(cm2.conversation_id AS TEXT)
     WHERE cm1.user_id = $1 AND cm2.user_id = $2
       AND COALESCE(c.is_group, FALSE) = FALSE
       AND COALESCE(c.is_task_group, FALSE) = FALSE
     LIMIT 1`,
    [userId, otherUserId]
  );

  if (existingConversation.rows.length > 0) {
    return {
      conversationId: existingConversation.rows[0].id,
      requestedId,
      resolvedFromLegacy: true,
      otherUserId,
    };
  }

  if (!options?.createDirectIfMissing) {
    return {
      conversationId: requestedId,
      requestedId,
      resolvedFromLegacy: false,
      otherUserId,
    };
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const convResult = await client.query(
      `INSERT INTO conversations (id, type, is_group, is_task_group, created_by, created_at, updated_at)
       VALUES (gen_random_uuid(), 'direct', FALSE, FALSE, $1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id`,
      [userId]
    );
    const newId = String(convResult.rows[0].id);

    await client.query(
      'INSERT INTO conversation_members (conversation_id, user_id, role, added_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
      [newId, userId, 'member']
    );
    await client.query(
      'INSERT INTO conversation_members (conversation_id, user_id, role, added_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
      [newId, otherUserId, 'member']
    );

    await client.query('COMMIT');

    return {
      conversationId: newId,
      requestedId,
      resolvedFromLegacy: true,
      otherUserId,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

/** Whether a user currently has a socket joined to the conversation room. */
export const isUserInConversationRoom = (
  io: Server,
  userId: string,
  conversationId: string
): boolean => {
  const room = io.sockets.adapter.rooms.get(conversationId);
  if (!room) return false;

  for (const socketId of room) {
    const sock = io.sockets.sockets.get(socketId) as { userId?: string } | undefined;
    if (sock?.userId === userId) return true;
  }
  return false;
};

/** Emit new_message once per member via personal rooms (avoids duplicate with conversation room). */
export const emitNewMessageToMembers = (
  io: Server,
  memberIds: string[],
  payload: Record<string, unknown>
): void => {
  const seen = new Set<string>();
  for (const memberId of memberIds) {
    if (!memberId || seen.has(memberId)) continue;
    seen.add(memberId);
    io.to(`user_${memberId}`).emit('new_message', payload);
    io.to(`user_${memberId}`).emit('receive_message', payload);
  }
};

/** Should we create an in-app / push notification for this recipient? */
export const shouldNotifyRecipient = (
  io: Server,
  recipientUserId: string,
  conversationId: string,
  activeUsers: Map<string, Set<string>>
): boolean => {
  if (!activeUsers.has(recipientUserId)) return true;
  return !isUserInConversationRoom(io, recipientUserId, conversationId);
};
