import { PoolClient } from 'pg';
import { Server } from 'socket.io';
import { query } from '../config/database';
import { emitNewMessageToMembers } from './conversationIdResolver';
import { dispatchNotification } from './notification-bus.service';
import { serializeTimestampForClient } from '../utils/deviceTime';

type DbClient = { query: (text: string, values?: any[]) => Promise<any> };

export type TaskActionType =
  | 'status_changed'
  | 'task_completed'
  | 'assignees_added'
  | 'member_completion_pending'
  | 'completion_verified'
  | 'member_reassigned'
  | 'delete_requested'
  | 'delete_approved'
  | 'delete_denied'
  | 'exit_requested'
  | 'exit_approved'
  | 'exit_rejected';

let messagesMetadataColumnExists: boolean | null = null;

const getMessagesMetadataColumnExists = async (): Promise<boolean> => {
  if (messagesMetadataColumnExists === null) {
    const r = await query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'messages' AND column_name = 'metadata'
       ) AS exists`
    );
    messagesMetadataColumnExists = Boolean(r.rows[0]?.exists);
  }
  return messagesMetadataColumnExists;
};

/** Human-readable status label for chat / notification copy (e.g. inprogress, todo). */
export const formatTaskStatusLabel = (status: string): string => {
  const s = String(status || '')
    .toLowerCase()
    .replace(/-/g, '_')
    .trim();
  const map: Record<string, string> = {
    todo: 'todo',
    pending: 'todo',
    active: 'inprogress',
    in_progress: 'inprogress',
    inprogress: 'inprogress',
    duesoon: 'duesoon',
    overdue: 'overdue',
    scheduled: 'scheduled',
    pending_verification: 'pending verification',
    completed: 'completed',
    rejected: 'rejected',
    deleted: 'deleted',
  };
  return map[s] || s.replace(/_/g, ' ');
};

export const buildTaskActionMessage = (input: {
  action: TaskActionType;
  actorName?: string | null;
  targetName?: string | null;
  status?: string | null;
  count?: number;
  reason?: string | null;
}): string => {
  const actor = String(input.actorName || '').trim() || 'User';
  const target = String(input.targetName || '').trim() || 'User';

  switch (input.action) {
    case 'task_completed':
      return 'Task is completed';
    case 'status_changed': {
      const label = formatTaskStatusLabel(input.status || '');
      if (label === 'completed') return 'Task is completed';
      return `${actor} status changed to ${label}`;
    }
    case 'assignees_added': {
      const count = input.count ?? 1;
      if (count > 1) return `${actor} added ${count} new assignees`;
      return `${actor} added ${target} to the task`;
    }
    case 'member_completion_pending':
      return `${actor} status changed to completed`;
    case 'completion_verified':
      return `${actor} verified ${target}'s completion`;
    case 'member_reassigned':
      return `${actor} changed ${target} status to inprogress`;
    case 'delete_requested':
      return `${actor} asked to delete this task: ${String(input.reason || '').trim()}`.trim();
    case 'delete_approved':
      return `${actor} approved deleting this task`;
    case 'delete_denied':
      return `${actor} declined the request to delete this task`;
    case 'exit_requested':
      return `${actor} requested task exit`;
    case 'exit_approved':
      return `${target} exited this task group`;
    case 'exit_rejected':
      return `${actor} rejected exit request from ${target}`;
    default:
      return `${actor} updated the task`;
  }
};

const resolveActorName = async (actorUserId: string): Promise<string> => {
  const r = await query(`SELECT name FROM users WHERE id = $1`, [actorUserId]);
  return r.rows[0]?.name || 'User';
};

const resolveTaskConversationId = async (taskId: string): Promise<string | null> => {
  const r = await query(
    `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
    [taskId]
  );
  return r.rows[0]?.id ?? null;
};

const insertSystemMessage = async (
  client: DbClient,
  params: {
    conversationId: string;
    senderId: string;
    content: string;
    metadata?: Record<string, unknown> | null;
  }
): Promise<{ id: string; created_at: Date }> => {
  const hasMeta = await getMessagesMetadataColumnExists();
  if (hasMeta) {
    const r = await client.query(
      `INSERT INTO messages (conversation_id, sender_id, content, message_type, metadata)
       VALUES ($1, $2, $3, 'system', $4::jsonb)
       RETURNING id, created_at`,
      [
        params.conversationId,
        params.senderId,
        params.content,
        JSON.stringify(params.metadata ?? { display: 'center' }),
      ]
    );
    return r.rows[0];
  }

  const r = await client.query(
    `INSERT INTO messages (conversation_id, sender_id, content, message_type)
     VALUES ($1, $2, $3, 'system')
     RETURNING id, created_at`,
    [params.conversationId, params.senderId, params.content]
  );
  return r.rows[0];
};

export type PostTaskUserActionMessageInput = {
  io?: Server | null;
  taskId: string;
  actorUserId: string;
  action: TaskActionType;
  conversationId?: string | null;
  actorName?: string | null;
  targetName?: string | null;
  targetUserId?: string | null;
  status?: string | null;
  count?: number;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  client?: PoolClient | DbClient | null;
};

/**
 * Insert a standardized system message in the task group chat and broadcast it.
 */
export const postTaskUserActionMessage = async (
  input: PostTaskUserActionMessageInput
): Promise<{ conversationId: string; messageId: string; content: string } | null> => {
  const conversationId =
    input.conversationId || (await resolveTaskConversationId(input.taskId));
  if (!conversationId) return null;

  const actorName =
    input.actorName?.trim() || (await resolveActorName(input.actorUserId));

  let targetName = input.targetName?.trim() || null;
  if (!targetName && input.targetUserId) {
    const tr = await query(`SELECT name FROM users WHERE id = $1`, [input.targetUserId]);
    targetName = tr.rows[0]?.name || 'User';
  }

  const content = buildTaskActionMessage({
    action: input.action,
    actorName,
    targetName,
    status: input.status,
    count: input.count,
    reason: input.reason,
  });

  const messageMetadata: Record<string, unknown> = {
    display: 'center',
    taskAction: input.action,
    ...(input.metadata ?? {}),
  };

  const db: DbClient = input.client || { query };
  const inserted = await insertSystemMessage(db, {
    conversationId,
    senderId: input.actorUserId,
    content,
    metadata: messageMetadata,
  });

  await db.query(
    'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id::text = $1::text',
    [conversationId]
  );

  const io = input.io;
  if (io) {
    const membersResult = await query(
      'SELECT user_id FROM conversation_members WHERE conversation_id::text = $1::text',
      [conversationId]
    );
    const memberIds = membersResult.rows.map((r: { user_id: string }) => r.user_id);
    const payload = {
      id: inserted.id,
      conversation_id: conversationId,
      task_id: input.taskId,
      sender_id: input.actorUserId,
      content,
      text: content,
      message_type: 'system',
      sender_name: actorName,
      created_at: serializeTimestampForClient(inserted.created_at) ?? inserted.created_at,
      status: 'sent',
      is_task_group: true,
      isTaskGroup: true,
      metadata: messageMetadata,
    };
    emitNewMessageToMembers(io, memberIds, payload);

    const recipients = memberIds.filter(
      (id: string) => String(id) !== String(input.actorUserId)
    );
    if (recipients.length > 0) {
      try {
        await dispatchNotification({
          type: 'MESSAGE_RECEIVED',
          recipientIds: recipients,
          title: 'Task update',
          body: content,
          refId: conversationId,
          refType: 'conversation',
          isTaskGroup: true,
          conversationId,
          io,
        });
      } catch (error: any) {
        console.warn('[postTaskUserActionMessage] notify failed:', error?.message || error);
      }
    }
  }

  return { conversationId, messageId: inserted.id, content };
};
