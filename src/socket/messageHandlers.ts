import { Server, Socket } from 'socket.io';
import { createMessage, updateMessageStatus, markMessagesAsRead } from '../services/messageService';
import { verifyToken } from '../utils/jwt';
import { query, getClient } from '../config/database';
import { getFileUrl } from '../services/mediaUploadService';
import { getValidatedDeviceTimestamp } from '../utils/deviceTime';
import { dispatchNotification } from '../services/notification-bus.service';

// Use existing Node firebaseAdmin helper for FCM push notifications
// eslint-disable-next-line @typescript-eslint/no-var-requires
const firebaseAdmin = require('../../services/firebaseAdmin') as {
  sendPushToTokens?: (
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string | number | boolean>
  ) => Promise<void>;
};

const sendPushToTokens = firebaseAdmin?.sendPushToTokens;

interface AuthenticatedSocket extends Socket {
  userId?: string;
  organizationId?: string;
}

/**
 * In-memory map: userId -> Set of socketIds.
 * Multiple tabs/devices = multiple sockets per user. User is "offline" only when Set is empty.
 */
const activeUsers = new Map<string, Set<string>>();

function getOnlineUserIds(): string[] {
  return Array.from(activeUsers.keys());
}

function registerUserSocket(userId: string, socketId: string): void {
  if (!activeUsers.has(userId)) {
    activeUsers.set(userId, new Set());
  }
  activeUsers.get(userId)!.add(socketId);
}

function unregisterUserSocket(userId: string, socketId: string): boolean {
  const set = activeUsers.get(userId);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) {
    activeUsers.delete(userId);
    return true;
  }
  return false;
}

/**
 * Helper: derive receiverId / groupId and conversationId string
 * from a conversation-style identifier (direct_<userId> / group_<groupId>)
 */
const getConversationContextFromId = (conversationId: string) => {
  let receiverId: string | null = null;
  let groupId: string | null = null;

  if (conversationId?.startsWith('direct_')) {
    receiverId = conversationId.replace('direct_', '');
  } else if (conversationId?.startsWith('group_')) {
    groupId = conversationId.replace('group_', '');
  }

  return { receiverId, groupId };
};

/**
 * Authenticate socket connection
 */
export const authenticateSocket = async (socket: AuthenticatedSocket, next: any) => {
  try {
    // Match message-backend: use only socket.handshake.auth.token
    const token = socket.handshake.auth?.token;

    if (!token) {
      console.error('❌ Socket authentication failed: No token provided');
      return next(new Error('No token provided'));
    }

    console.log('🔍 Socket authentication attempt - token preview:', token.substring(0, 20) + '...');

    const decoded = verifyToken(token);
    console.log('✅ Token verified successfully for user:', decoded.userId);
    
    socket.userId = decoded.userId;
    
    // Fetch organizationId from database (JWT doesn't include it)
    // This matches the REST API middleware behavior
    // Note: organizationId is optional - only required for group messages, not direct messages
    const orgResult = await query(
      `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
      [decoded.userId]
    );
    socket.organizationId = orgResult.rows.length > 0 ? orgResult.rows[0].organization_id : undefined;

    // Only log warning if organizationId is missing (it's needed for group messages)
    // Direct messages don't require organizationId
    if (!socket.organizationId) {
      console.log(`ℹ️ User ${decoded.userId} has no organization assigned (will only be able to send direct messages)`);
    }

    next();
  } catch (error: any) {
    console.error('❌ Socket authentication error:', error.message || error);
    console.error('❌ Error details:', {
      message: error.message,
      name: error.name,
      stack: error.stack?.split('\n').slice(0, 3).join('\n'),
    });
    // Pass the actual error message to help with debugging
    next(new Error(`Authentication failed: ${error.message || 'Invalid token'}`));
  }
};

/**
 * Setup message socket handlers
 */
export const setupMessageHandlers = (io: Server) => {
  io.use(authenticateSocket);

  io.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.userId!;
    const organizationId = socket.organizationId;
    const socketId = socket.id;

    registerUserSocket(userId, socketId);
    console.log('[socket] user connected', { userId, socketId, totalSocketsForUser: activeUsers.get(userId)!.size });

    if (organizationId) {
      console.log(`User ${userId} connected via socket (organization: ${organizationId})`);
    } else {
      console.log(`ℹ️ User ${userId} connected via socket (no organization - can send direct messages only)`);
    }

    socket.join(`user_${userId}`);

    socket.broadcast.emit('user_online', { userId });
    io.emit('online_users', { userIds: getOnlineUserIds() });

    // Step 8: Handle offline users - Send pending messages when user comes online
    // When user comes ONLINE:
    // 1. Client connects socket (already done above)
    // 2. Backend queries unread messages
    // 3. Sends pending messages
    (async () => {
      try {
        // Get all conversations user is part of
        // Note: This offline message handling is not in message-backend, but we keep it for completeness
        const conversationsResult = await query(
          `SELECT DISTINCT conversation_id 
           FROM conversation_members 
           WHERE user_id = $1`,
          [userId]
        );

        // For each conversation, get unread messages
        for (const row of conversationsResult.rows) {
          const conversationId = row.conversation_id;

          // Query unread messages for this conversation
          // SELECT * FROM messages WHERE conversation_id = $1 AND status != 'read'
          // Check message_status table to find messages not yet read by this user
          const unreadMessagesResult = await query(
            `SELECT m.*, u.name as sender_name,
                    COALESCE(ms.status, 'sent') as status
             FROM messages m
             LEFT JOIN users u ON m.sender_id = u.id
             LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = $2
             WHERE m.conversation_id = $1 
               AND m.sender_id != $2
               AND (ms.status IS NULL OR ms.status != 'read')
               AND m.is_deleted = false
             ORDER BY m.created_at ASC
             LIMIT 50`,
            [conversationId, userId]
          );

          // Send pending messages to user
          for (const msg of unreadMessagesResult.rows) {
            const messagePayload: any = {
              id: msg.id,
              conversation_id: conversationId,
              sender_id: msg.sender_id,
              receiver_id: msg.receiver_id,
              group_id: msg.group_id,
              content: msg.content,
              text: msg.content, // Also include 'text' for compatibility
              message_type: msg.message_type,
              media_url: msg.media_url ? getFileUrl(msg.media_url) : msg.media_url,
              media_thumbnail: msg.media_thumbnail,
              file_name: msg.file_name,
              file_size: msg.file_size,
              mime_type: msg.mime_type,
              duration: msg.duration,
              sender_name: msg.sender_name,
              created_at: msg.created_at,
              status: msg.status || 'sent',
              deleted_for_all: msg.deleted_for_everyone,
            };

            // Emit pending message
            socket.emit('new_message', messagePayload);

            // Update status to delivered since user is now online (if not already delivered)
            if (msg.status !== 'delivered' && msg.status !== 'read') {
              await updateMessageStatus(msg.id, userId, 'delivered');
            }
          }
        }

        console.log(`Sent pending messages to user ${userId}`);
      } catch (error: any) {
        console.error(`Error sending pending messages to user ${userId}:`, error);
      }
    })();

    /**
     * CANONICAL EVENTS (used by new web/mobile code)
     * --------------------------------------------
     */

    // Handle sending messages (canonical API)
    socket.on('message:send', async (data) => {
      try {
        const {
          receiverId,
          groupId,
          messageType,
          content,
          mediaUrl,
          fileName,
          fileSize,
          mimeType,
          visibilityMode = 'shared_to_group',
          replyToMessageId,
          forwardedFromMessageId,
          mentions = [],
          taskMentions = [],
          deviceTimestamp,
        } = data;

        // OrganizationId is required for regular group messages, but NOT for task groups
        // Task groups allow non-organization users to participate
        // Direct messages also don't require organization
        const isGroupMessage = !!groupId;
        
        // Check if this is a task group conversation
        let isTaskGroup = false;
        if (groupId) {
          const convCheck = await query(
            'SELECT is_task_group FROM conversations WHERE id = $1',
            [groupId]
          );
          isTaskGroup = convCheck.rows.length > 0 && convCheck.rows[0].is_task_group === true;
        }
        
        if (isGroupMessage && !isTaskGroup && !organizationId) {
          console.error(`[message:send] User ${userId} has no organization assigned (required for group messages)`);
          socket.emit('message:error', { 
            error: 'Cannot send group message: User is not assigned to an organization. Please contact support.' 
          });
          return;
        }

        // For direct messages and task groups, organizationId can be NULL
        // For regular group messages, organizationId is required (validated above)
        let senderOrganizationId: string | null = null;
        if (isGroupMessage && !isTaskGroup && organizationId) {
          senderOrganizationId = organizationId as string;
        }

        const createdAt = getValidatedDeviceTimestamp(deviceTimestamp) || new Date();
        const safeReplyToMessageId = (replyToMessageId ?? null) as string | null;
        const safeForwardedFromMessageId = (forwardedFromMessageId ?? null) as string | null;

        const message = await createMessage(
          userId,
          receiverId ?? null,
          groupId ?? null,
          messageType,
          content ?? null,
          mediaUrl ?? null,
          fileName ?? null,
          fileSize ?? null,
          mimeType ?? null,
          visibilityMode,
          senderOrganizationId,
          safeReplyToMessageId,
          safeForwardedFromMessageId,
          mentions,
          taskMentions,
          null, // mediaThumbnail
          null, // duration
          null, // locationLat
          null, // locationLng
          null, // locationAddress
          false, // isLiveLocation
          null, // liveLocationExpiresAt
          createdAt
        );

        // Emit to receiver (one-to-one) or group members - use user_ room (clients join user_${userId})
        if (receiverId) {
          // One-to-one message
          io.to(`user_${receiverId}`).emit('message:received', message);
          socket.emit('message:sent', message);
        } else if (groupId) {
          // Group message - get all members
          const membersResult = await query(
            `SELECT user_id, organization_id FROM group_members WHERE group_id = $1`,
            [groupId]
          );

          // Emit to all members who can see the message
          for (const member of membersResult.rows) {
            if (member.user_id === userId) {
              socket.emit('message:sent', message);
            } else if (
              visibilityMode === 'shared_to_group' ||
              (visibilityMode === 'org_only' && member.organization_id === organizationId)
            ) {
              io.to(`user_${member.user_id}`).emit('message:received', message);
            }
          }
        }
      } catch (error: any) {
        socket.emit('message:error', { error: error.message });
      }
    });

    // Handle message delivery confirmation
    socket.on('message:delivered', async (data) => {
      try {
        const { messageId } = data;
        await updateMessageStatus(messageId, userId, 'delivered');
        socket.emit('message:delivered:confirmed', { messageId });
      } catch (error: any) {
        socket.emit('message:error', { error: error.message });
      }
    });

    // Handle message read receipt
    socket.on('message:read', async (data) => {
      try {
        const { messageId } = data;
        await updateMessageStatus(messageId, userId, 'read');

        // Notify sender
        const messageResult = await query('SELECT sender_id FROM messages WHERE id = $1', [messageId]);
        if (messageResult.rows.length > 0) {
          const senderId = messageResult.rows[0].sender_id;
          io.to(`user_${senderId}`).emit('message:read:notification', {
            messageId,
            readBy: userId,
          });

          // Backwards-compatible status update event for legacy mobile client
          io.to(`user_${senderId}`).emit('message_status_update', {
            messageId,
            status: 'read',
          });
        }
      } catch (error: any) {
        socket.emit('message:error', { error: error.message });
      }
    });

    // Handle marking messages as read (canonical)
    socket.on('messages:mark-read', async (data) => {
      try {
        const { receiverId, groupId } = data;
        await markMessagesAsRead(userId, receiverId || null, groupId || null);

        // Notify the other party
        if (receiverId) {
          io.to(`user_${receiverId}`).emit('messages:read:notification', {
            readBy: userId,
          });
        } else if (groupId) {
          // Notify all group members
          const membersResult = await query(
            `SELECT user_id FROM group_members WHERE group_id = $1 AND user_id != $2`,
            [groupId, userId]
          );
          for (const member of membersResult.rows) {
            io.to(`user_${member.user_id}`).emit('messages:read:notification', {
              groupId,
              readBy: userId,
            });
          }
        }
      } catch (error: any) {
        socket.emit('message:error', { error: error.message });
      }
    });

    /**
     * LEGACY MOBILE EVENTS (compatibility layer)
     * -----------------------------------------
     * These events support the existing React Native client which uses:
     * - send_message / new_message
     * - message_read / conversation_messages_read
     * - message_status_update
     */

    // Legacy: send_message from mobile ChatScreen (enhanced with all fields and notifications)
    // Supports both 'text' and 'content' fields for compatibility
    // CRITICAL FIX: Works with UUID conversation IDs directly (not direct_/group_ format)
    socket.on('send_message', async (data) => {
      try {
        const {
          conversationId,
          messageType = 'text',
          content,
          text, // Support 'text' field as specified in flow
          mediaUrl,
          mediaThumbnail,
          fileName,
          fileSize,
          mimeType,
          duration,
          replyToMessageId,
          locationLat,
          locationLng,
          locationAddress,
          isLiveLocation,
          liveLocationExpiresAt,
          visibilityMode, // optional, for per-message visibility
          deviceTimestamp,
        } = data;

        if (!conversationId) {
          socket.emit('error', { message: 'conversationId is required' });
          return;
        }

        // Use 'text' if provided, otherwise use 'content' (matching message-backend)
        const messageContent = text || content;

        // Handle backward compatibility: If conversationId is in direct_<userId> format,
        // find or create the UUID conversation between the two users
        let actualConversationId = conversationId;
        
        if (conversationId.startsWith('direct_')) {
          // Extract the user ID from direct_<userId> format
          const extractedUserId = conversationId.replace('direct_', '');
          
          // Determine the other user ID
          let otherUserId: string;
          if (extractedUserId === userId) {
            // The conversationId is using sender's ID - find the other user from conversation_members
            const otherMemberResult = await query(
              'SELECT user_id FROM conversation_members WHERE conversation_id::text = $1::text AND user_id != $2 LIMIT 1',
              [conversationId, userId]
            );
            if (otherMemberResult.rows.length === 0) {
              socket.emit('error', { message: 'Invalid conversation: cannot find other user. Please create conversation first.' });
              return;
            }
            otherUserId = otherMemberResult.rows[0].user_id;
          } else {
            otherUserId = extractedUserId;
          }

          // Prevent sending message to yourself
          if (otherUserId === userId) {
            socket.emit('error', { message: 'Cannot send message to yourself' });
            return;
          }

          // Check if a UUID conversation already exists between these two users
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
            // Use the existing UUID conversation
            actualConversationId = existingConversation.rows[0].id;
            console.log(`[send_message] Found existing UUID conversation ${actualConversationId} for direct_${extractedUserId}, using UUID`);
          } else {
            // Create a new UUID conversation (matching message-backend flow)
            const client = await getClient();
            try {
              await client.query('BEGIN');

              const convResult = await client.query(
                `INSERT INTO conversations (id, type, is_group, is_task_group, created_by, created_at, updated_at)
                 VALUES (gen_random_uuid(), 'direct', FALSE, FALSE, $1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                 RETURNING id`,
                [userId]
              );
              actualConversationId = String(convResult.rows[0].id);

              await client.query(
                'INSERT INTO conversation_members (conversation_id, user_id, role, added_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
                [actualConversationId, userId, 'member']
              );

              await client.query(
                'INSERT INTO conversation_members (conversation_id, user_id, role, added_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
                [actualConversationId, otherUserId, 'member']
              );

              await client.query('COMMIT');
              console.log(`[send_message] Created new UUID conversation ${actualConversationId} for direct_${extractedUserId}`);
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
          }
        }

        // Verify user is member of conversation (matching message-backend EXACTLY)
        const memberCheck = await query(
          'SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
          [actualConversationId, userId]
        );

        if (memberCheck.rows.length === 0) {
          socket.emit('error', { message: 'Not a member of this conversation' });
          return;
        }

        // Get conversation details to determine receiver_id or group_id
        const convResult = await query(
          'SELECT is_group, is_task_group FROM conversations WHERE id = $1',
          [actualConversationId]
        );

        if (convResult.rows.length === 0) {
          socket.emit('error', { message: 'Conversation not found' });
          return;
        }

        const isGroup = convResult.rows[0].is_group;
        const isTaskGroup = convResult.rows[0].is_task_group;

        // Determine visibility mode for this message
        // - Direct messages: always 'private'
        // - Regular groups: 'shared_to_group' only
        // - Task groups: 'shared_to_group' (default) or 'org_only' when sender has an organization
        let finalVisibilityMode: 'shared_to_group' | 'org_only' | 'private' = 'shared_to_group';

        if (!isGroup && !isTaskGroup) {
          // Direct / non-group conversation
          finalVisibilityMode = 'private';
        } else if (isTaskGroup) {
          // Task group: allow per-message visibility
          const rawVisibility = (visibilityMode || (data as any).visibility_mode || '').toString();
          if (rawVisibility === 'org_only') {
            if (!organizationId) {
              console.warn(
                `[send_message] User ${userId} attempted to send org_only message in task group without organization`
              );
              socket.emit('error', {
                message:
                  'Cannot send Org-Only message because your account is not linked to an organization.',
              });
              return;
            }
            finalVisibilityMode = 'org_only';
          } else {
            finalVisibilityMode = 'shared_to_group';
          }
        } else {
          // Regular group: keep existing behaviour (shared to entire group)
          finalVisibilityMode = 'shared_to_group';
        }

        // OrganizationId is required for regular group messages, but NOT for task groups
        // Task groups allow non-organization users to participate
        // Direct messages also don't require organization
        if (isGroup && !isTaskGroup && !organizationId) {
          console.error(
            `[send_message] User ${userId} has no organization assigned (required for group messages)`
          );
          socket.emit('error', {
            message:
              'Cannot send group message: User is not assigned to an organization. Please contact support.',
          });
          return;
        }

        // For direct messages and task groups, organizationId can be NULL
        // For regular group messages, organizationId is required (validated above)
        let senderOrganizationId: string | null = null;
        if ((isGroup || isTaskGroup) && organizationId) {
          senderOrganizationId = organizationId as string;
        }

        // Get sender info (matching message-backend: use profile_photo)
        const userResult = await query(
          'SELECT name, profile_photo_url as profile_photo FROM users WHERE id = $1',
          [userId]
        );
        const senderName = userResult.rows[0]?.name || 'Unknown';
        const senderPhoto = userResult.rows[0]?.profile_photo || null;

        // Determine created_at using validated device timestamp (falls back to server time)
        const createdAt = getValidatedDeviceTimestamp(deviceTimestamp) || new Date();

        // Save message to database using createdAt
        const result = await query(
          `INSERT INTO messages (
            conversation_id, sender_id, content, message_type, media_url, media_thumbnail,
            file_name, file_size, duration, reply_to_message_id,
            location_lat, location_lng, location_address, is_live_location, live_location_expires_at,
            receiver_id, sender_organization_id, visibility_mode, created_at
          )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NULL, $16, $17, $18)
           RETURNING *`,
          [
            actualConversationId, // $1
            userId, // $2
            messageContent, // $3
            messageType, // $4
            mediaUrl || null, // $5
            mediaThumbnail || null, // $6
            fileName || null, // $7
            fileSize || null, // $8
            duration || null, // $9
            replyToMessageId || null, // $10
            locationLat || null, // $11
            locationLng || null, // $12
            locationAddress || null, // $13
            isLiveLocation || false, // $14
            liveLocationExpiresAt || null, // $15
            senderOrganizationId, // $16
            finalVisibilityMode, // $17
            createdAt, // $18
          ]
        );

        const message = result.rows[0];
        console.log('[send_message] message received and saved', {
          messageId: message.id,
          conversationId: actualConversationId,
          senderId: userId,
        });

        // Get reply info if exists
        let replyTo = null;
        if (replyToMessageId) {
          const replyResult = await query(
            `SELECT m.id, m.content, m.message_type, u.name as sender_name
             FROM messages m
             JOIN users u ON m.sender_id = u.id
             WHERE m.id = $1`,
            [replyToMessageId]
          );
          if (replyResult.rows.length > 0) {
            replyTo = replyResult.rows[0];
          }
        }

        // Build message payload (matching message-backend structure exactly)
        const messagePayload: any = {
          ...message, // Start with all DB fields
          conversation_id: actualConversationId,
          sender_id: userId,
          content: message.content,
          text: message.content, // Also include 'text' for compatibility
          message_type: messageType,
          media_url: message.media_url ? getFileUrl(message.media_url) : message.media_url,
          sender_name: senderName,
          sender_photo: senderPhoto,
          reply_to: replyTo || undefined,
          status: 'sent', // Initial status (matching message-backend)
        };

        // Get conversation members first (matching message-backend)
        const conversationMembers = await query(
          'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
          [actualConversationId]
        );

        console.log(
          `[send_message] Emitting to conversation ${actualConversationId}, members: ${conversationMembers.rows.length}`,
          conversationMembers.rows.map((r: any) => r.user_id)
        );

        // Determine which members should receive this message based on visibility
        let visibleMemberIds: string[] = conversationMembers.rows.map((r: any) => r.user_id);

        if ((isGroup || isTaskGroup) && finalVisibilityMode === 'org_only' && senderOrganizationId) {
          // For org-only messages in group / task group, only members in the same organization should see the message
          const visibleMembersResult = await query(
            `SELECT cm.user_id
             FROM conversation_members cm
             JOIN user_organizations uo ON cm.user_id = uo.user_id
             WHERE cm.conversation_id = $1 AND uo.organization_id = $2`,
            [actualConversationId, senderOrganizationId]
          );
          visibleMemberIds = visibleMembersResult.rows.map((r: any) => r.user_id);
          console.log(
            `[send_message] Org-only message – visible members:`,
            visibleMemberIds
          );
        }

        if (!(isGroup || isTaskGroup) || finalVisibilityMode !== 'org_only') {
          io.to(actualConversationId).emit('new_message', messagePayload);
        }

        for (const memberId of visibleMemberIds) {
          io.to(`user_${memberId}`).emit('new_message', messagePayload);
          io.to(`user_${memberId}`).emit('receive_message', messagePayload);
        }
        console.log('[send_message] message emitted', {
          messageId: message.id,
          conversationId: actualConversationId,
          recipientCount: visibleMemberIds.length,
          recipientIds: visibleMemberIds,
        });

        await query(
          'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
          [actualConversationId]
        );

        // Message lifecycle: Sent → Delivered → Read
        // Message starts as 'sent' (already set in INSERT)
        message.status = 'sent';

        // Check which users are online and update to 'delivered' for them (matching message-backend)
        const otherMembers = await query(
          'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id != $2',
          [actualConversationId, userId]
        );

        const onlineUsers: string[] = otherMembers.rows
          .filter((m: any) => activeUsers.has(m.user_id))
          .map((m: any) => m.user_id);
        // Update message_status to 'delivered' for online recipients (messages table has no status column)
        if (onlineUsers.length > 0) {
          for (const uid of onlineUsers) {
            await query(
              `INSERT INTO message_status (message_id, user_id, status, status_at)
               VALUES ($1, $2, 'delivered', NOW())
               ON CONFLICT (message_id, user_id) DO UPDATE SET status = 'delivered', status_at = NOW()`,
              [message.id, uid]
            ).catch(() => {});
          }
        }

        // Emit status update if delivered (matching message-backend)
        if (onlineUsers.length > 0) {
          (message as any).status = 'delivered';
          io.to(actualConversationId).emit('message_status_update', {
            messageId: message.id,
            conversationId: actualConversationId,
            status: 'delivered',
          });
          
          // Also emit to each member's personal room (matching message-backend)
          for (const member of conversationMembers.rows) {
            io.to(`user_${member.user_id}`).emit('message_status_update', {
              messageId: message.id,
              conversationId: actualConversationId,
              status: 'delivered',
            });
          }
        }

        // Create notifications and send FCM push for offline users (matching message-backend)
        for (const member of otherMembers.rows) {
          if (!onlineUsers.includes(member.user_id)) {
            const notificationBody = messageContent
              ? (messageContent.length > 50 ? messageContent.substring(0, 50) + '...' : messageContent)
              : (messageType === 'image' ? '📷 Photo'
                : messageType === 'video' ? '🎥 Video'
                : messageType === 'audio' || messageType === 'voice' ? '🎤 Audio'
                : messageType === 'document' ? '📄 Document'
                : messageType === 'location' ? '📍 Location'
                : `Sent a ${messageType}`);

            const notificationTitle = `New message from ${senderName}`;

            await dispatchNotification({
              type: 'MESSAGE_RECEIVED',
              recipientIds: [member.user_id],
              title: notificationTitle,
              body: notificationBody,
              refType: 'conversation',
              refId: actualConversationId || message.id,
              channels: ['in_app'],
              io,
            });

            // Fire-and-forget FCM push (same pattern as legacy JS socket)
            if (sendPushToTokens) {
              query('SELECT token FROM user_push_tokens WHERE user_id = $1', [member.user_id])
                .then((tokenResult) => {
                  const tokens = (tokenResult.rows || [])
                    .map((r: any) => r.token)
                    .filter(Boolean);

                  if (tokens.length > 0) {
                    console.log(
                      '[send_message] Sending FCM push',
                      { userId: member.user_id, tokens: tokens.length, conversationId: actualConversationId }
                    );
                    sendPushToTokens(tokens, notificationTitle, notificationBody, {
                      conversationId: String(actualConversationId),
                      type: 'message',
                    });
                  }
                })
                .catch((err: any) => {
                  console.warn(
                    '[send_message] FCM token fetch error:',
                    err?.message || err
                  );
                });
            }
          }
        }
      } catch (error: any) {
        // CRITICAL FIX: Use data object for error logging (variables may not be in scope)
        const errorConversationId = data?.conversationId || 'unknown';
        const errorUserId = socket.userId || 'unknown';
        const errorOrganizationId = socket.organizationId || 'unknown';
        const errorMessageContent = data?.content || data?.text || 'unknown';
        const errorMessageType = data?.messageType || 'unknown';

        console.error('[send_message] Error:', error.message);
        console.error('[send_message] Error stack:', error.stack);
        console.error('[send_message] Error details:', {
          conversationId: errorConversationId,
          userId: errorUserId,
          organizationId: errorOrganizationId,
          messageContent: typeof errorMessageContent === 'string' ? errorMessageContent.substring(0, 50) : 'unknown',
          messageType: errorMessageType,
        });
        socket.emit('error', {
          message: 'Failed to send message',
          details: error.message
        });
      }
    });

    // Legacy: message_read from mobile (per-message or whole conversation)
    socket.on('message_read', async (data) => {
      try {
        const { conversationId, messageId } = data || {};

        if (messageId && conversationId) {
          // Mark a single message as read
          const messageCheck = await query(
            `SELECT m.id, m.sender_id
             FROM messages m
             JOIN conversation_members cm ON m.conversation_id = cm.conversation_id
             WHERE m.id = $1 AND m.conversation_id = $2 AND cm.user_id = $3`,
            [messageId, conversationId, userId]
          );

          if (messageCheck.rows.length > 0 && messageCheck.rows[0].sender_id !== userId) {
            // CRITICAL FIX: message_status table might use 'status_at' instead of 'created_at'
            try {
              await query(
                `INSERT INTO message_status (message_id, user_id, status, status_at)
                 VALUES ($1, $2, 'read', NOW())
                 ON CONFLICT (message_id, user_id) 
                 DO UPDATE SET status = 'read', status_at = NOW()`,
                [messageId, userId]
              );
            } catch (error: any) {
              // If error is about column name, try with created_at
              if (error.message && error.message.includes('created_at')) {
                await query(
                  `INSERT INTO message_status (message_id, user_id, status, created_at)
                   VALUES ($1, $2, 'read', NOW())
                   ON CONFLICT (message_id, user_id) 
                   DO UPDATE SET status = 'read', updated_at = NOW()`,
                  [messageId, userId]
                );
              } else {
                // If message_status table doesn't exist or has different structure, skip it
                console.warn('[message_read] Could not update message_status table:', error.message);
              }
            }

            // Status is stored in message_status only (messages table has no status column)

            io.to(conversationId).emit('message_status_update', {
              messageId,
              conversationId,
              status: 'read',
            });

            // Also emit to sender's personal room - matching message-backend: user_${userId}
            const senderId = messageCheck.rows[0].sender_id;
            io.to(`user_${senderId}`).emit('message_status_update', {
              messageId,
              conversationId,
              status: 'read',
            });
          }
        } else if (conversationId) {
          // Check if this is a group conversation
          const convInfoResult = await query(
            `SELECT is_group, is_task_group FROM conversations WHERE id::text = $1::text`,
            [conversationId]
          );
          const isGroup = convInfoResult.rows[0]?.is_group || convInfoResult.rows[0]?.is_task_group || false;

          // For group and direct: status is in message_status only (messages table has no status column)
          let unreadMessages;
          
          if (isGroup) {
            // Group chat: Only update message_status table, NOT messages.status
            // Get all unread messages for this user in this conversation
            unreadMessages = await query(
              `SELECT m.id 
               FROM messages m
               LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = $2
               WHERE m.conversation_id::text = $1::text 
               AND m.sender_id != $2 
               AND (ms.status IS NULL OR ms.status != 'read')
               AND m.is_deleted = false
               AND m.deleted_at IS NULL`,
              [conversationId, userId]
            );
          } else {
            // Direct chat: status in message_status only; get unread message IDs to mark as read
            unreadMessages = await query(
              `SELECT m.id FROM messages m
               LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = $2
               WHERE m.conversation_id::text = $1::text AND m.sender_id != $2
                 AND (ms.status IS NULL OR ms.status != 'read')
                 AND m.deleted_at IS NULL`,
              [conversationId, userId]
            );
          }

          for (const msg of unreadMessages.rows) {
            // CRITICAL FIX: message_status table might use 'status_at' instead of 'created_at'
            try {
              await query(
                `INSERT INTO message_status (message_id, user_id, status, status_at)
                 VALUES ($1, $2, 'read', NOW())
                 ON CONFLICT (message_id, user_id) 
                 DO UPDATE SET status = 'read', status_at = NOW()`,
                [msg.id, userId]
              );
            } catch (error: any) {
              // If error is about column name, try with created_at
              if (error.message && error.message.includes('created_at')) {
                await query(
                  `INSERT INTO message_status (message_id, user_id, status, created_at)
                   VALUES ($1, $2, 'read', NOW())
                   ON CONFLICT (message_id, user_id) 
                   DO UPDATE SET status = 'read', updated_at = NOW()`,
                  [msg.id, userId]
                );
              } else {
                // If message_status table doesn't exist or has different structure, skip it
                console.warn('[message_read] Could not update message_status table:', error.message);
              }
            }
          }

          // Get conversation members to emit to their personal rooms
          const convMembers = await query(
            'SELECT user_id FROM conversation_members WHERE conversation_id::text = $1::text',
            [conversationId]
          );

          // Emit a single event for all messages marked as read in this conversation
          io.to(conversationId).emit('conversation_messages_read', {
            conversationId,
            status: 'read',
          });

          // Also emit to each member's personal room - matching message-backend: user_${userId}
          for (const member of convMembers.rows) {
            io.to(`user_${member.user_id}`).emit('conversation_messages_read', {
              conversationId,
              status: 'read',
            });
          }

          // Also emit individual updates for each message
          for (const msg of unreadMessages.rows) {
            // Get message sender to check if we need to update their view
            const msgInfo = await query(
              `SELECT sender_id FROM messages WHERE id = $1`,
              [msg.id]
            );
            const senderId = msgInfo.rows[0]?.sender_id;

            // For task groups: Check if all recipients have read this message
            if (isGroup && senderId) {
              // Get total recipients (excluding sender)
              const totalRecipients = await query(
                `SELECT COUNT(DISTINCT cm.user_id) as count
                 FROM conversation_members cm
                 WHERE cm.conversation_id::text = $1::text AND cm.user_id != $2`,
                [conversationId, senderId]
              );
              const totalRecipientsCount = parseInt(totalRecipients.rows[0]?.count || '0');

              // Get count of recipients who have read this message
              const readRecipients = await query(
                `SELECT COUNT(DISTINCT ms.user_id) as count
                 FROM message_status ms
                 WHERE ms.message_id = $1 
                   AND ms.status = 'read'
                   AND ms.user_id != $2`,
                [msg.id, senderId]
              );
              const readRecipientsCount = parseInt(readRecipients.rows[0]?.count || '0');

              // If all recipients have read, emit "read" to sender
              if (totalRecipientsCount > 0 && readRecipientsCount >= totalRecipientsCount) {
                io.to(`user_${senderId}`).emit('message_status_update', {
                  messageId: msg.id,
                  conversationId,
                  status: 'read',
                });
              }
            }

            // Always emit "read" status to the current user (receiver) who just read it
            io.to(`user_${userId}`).emit('message_status_update', {
              messageId: msg.id,
              conversationId,
              status: 'read',
            });

            // Also emit to conversation room for real-time updates
            io.to(conversationId).emit('message_status_update', {
              messageId: msg.id,
              conversationId,
              status: 'read',
              userId, // Include userId so clients know who read it
            });
          }
        }
      } catch (error: any) {
        socket.emit('message:error', { error: error.message });
      }
    });

    // Join group room (kept for potential future use)
    socket.on('group:join', (groupId: string) => {
      socket.join(`group:${groupId}`);
      console.log(`User ${userId} joined group ${groupId}`);
    });

    // Leave group room
    socket.on('group:leave', (groupId: string) => {
      socket.leave(`group:${groupId}`);
      console.log(`User ${userId} left group ${groupId}`);
    });

    // Join conversation room - resolve direct_<userId> to UUID so client receives emits (send_message emits to UUID room)
    socket.on('join_conversation', async (conversationId: string) => {
      try {
        let roomToJoin = conversationId;

        // Resolve direct_<userId> to actual UUID conversation so we join the same room send_message emits to
        if (conversationId.startsWith('direct_')) {
          const extractedUserId = conversationId.replace('direct_', '');
          const otherUserId = extractedUserId === userId
            ? (await query(
                'SELECT user_id FROM conversation_members WHERE conversation_id::text = $1::text AND user_id != $2 LIMIT 1',
                [conversationId, userId]
              )).rows[0]?.user_id
            : extractedUserId;
          if (otherUserId) {
            const existingConv = await query(
              `SELECT CAST(c.id AS TEXT) as id FROM conversations c
               INNER JOIN conversation_members cm1 ON CAST(c.id AS TEXT) = CAST(cm1.conversation_id AS TEXT)
               INNER JOIN conversation_members cm2 ON CAST(c.id AS TEXT) = CAST(cm2.conversation_id AS TEXT)
               WHERE cm1.user_id = $1 AND cm2.user_id = $2 AND COALESCE(c.is_group, FALSE) = FALSE AND COALESCE(c.is_task_group, FALSE) = FALSE
               LIMIT 1`,
              [userId, otherUserId]
            );
            if (existingConv.rows.length > 0) {
              roomToJoin = existingConv.rows[0].id;
            }
          }
        }

        // Check membership (by room we will join: UUID or original id)
        const membershipCheck = await query(
          `SELECT 1 FROM conversation_members 
           WHERE conversation_id::text = $1::text AND user_id = $2`,
          [roomToJoin, userId]
        );

        if (membershipCheck.rows.length > 0) {
          socket.join(roomToJoin);
          if (roomToJoin !== conversationId) socket.join(conversationId); // also join legacy id for compatibility
          console.log(`User ${userId} joined conversation ${roomToJoin}`);

          if (!socket.rooms.has(`user_${userId}`)) {
            socket.join(`user_${userId}`);
          }
        } else {
          const { receiverId } = getConversationContextFromId(conversationId);
          if (receiverId) {
            // Check messages by conversation_id (UUID) or by sender/receiver (legacy)
            const messageCheck = await query(
              `SELECT 1 FROM messages 
               WHERE (conversation_id::text = $1::text OR (((sender_id = $2 AND receiver_id = $3) OR (sender_id = $3 AND receiver_id = $2)) AND (group_id IS NULL OR group_id::text = '')))
                 AND deleted_at IS NULL
               LIMIT 1`,
              [roomToJoin, userId, receiverId]
            );

            if (messageCheck.rows.length > 0) {
              // Only insert into conversation_members if roomToJoin is UUID (not direct_xxx)
              const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roomToJoin);
              if (isUuid) {
                await query(
                  `INSERT INTO conversation_members (conversation_id, user_id)
                   VALUES ($1, $2), ($1, $3)
                   ON CONFLICT (conversation_id, user_id) DO NOTHING`,
                  [roomToJoin, userId, receiverId]
                );
              }
              socket.join(roomToJoin);
              if (roomToJoin !== conversationId) socket.join(conversationId);
              console.log(`User ${userId} auto-joined conversation ${roomToJoin} (direct chat)`);
            } else {
              socket.emit('message:error', { error: 'Not a member of this conversation' });
            }
          } else {
            socket.emit('message:error', { error: 'Not a member of this conversation' });
          }
        }
      } catch (error: any) {
        socket.emit('message:error', { error: error.message });
      }
    });

    // Leave conversation room
    socket.on('leave_conversation', (conversationId: string) => {
      socket.leave(conversationId);
      console.log(`User ${userId} left conversation ${conversationId}`);
    });

    // Typing indicator
    socket.on('typing', async (data: { conversationId: string; isTyping: boolean }) => {
      try {
        const { conversationId, isTyping } = data;

        // Check membership
        const membershipCheck = await query(
          `SELECT 1 FROM conversation_members 
           WHERE conversation_id::text = $1::text AND user_id = $2`,
          [conversationId, userId]
        );

        if (membershipCheck.rows.length > 0) {
          // Emit to others in conversation
          socket.to(conversationId).emit('typing', {
            userId,
            conversationId,
            isTyping,
          });
        }
      } catch (error: any) {
        socket.emit('message:error', { error: error.message });
      }
    });

    socket.on('get_online_users', () => {
      socket.emit('online_users', { userIds: getOnlineUserIds() });
    });

    socket.on('check_user_online', async (data: { userId: string }, callback?: (isOnline: boolean) => void) => {
      try {
        const { userId: targetUserId } = data;
        const isOnline = activeUsers.has(targetUserId);

        if (callback && typeof callback === 'function') {
          callback(isOnline);
        }
        socket.emit('user_online_status', { userId: targetUserId, isOnline });
      } catch (error: any) {
        console.error('[check_user_online] error:', error);
        if (callback && typeof callback === 'function') {
          callback(false);
        }
      }
    });

    // Add reaction (real-time)
    socket.on('message_reaction', async (data: { messageId: string; conversationId: string; reaction: string }) => {
      try {
        const { messageId, conversationId, reaction } = data;

        // Insert reaction
        await query(
          `INSERT INTO message_reactions (id, message_id, user_id, reaction, created_at)
           VALUES (gen_random_uuid(), $1, $2, $3, NOW())
           ON CONFLICT (message_id, user_id, reaction) DO NOTHING`,
          [messageId, userId, reaction]
        );

        // Emit to conversation room
        io.to(conversationId).emit('message_reaction_added', {
          messageId,
          userId,
          reaction,
        });
      } catch (error: any) {
        socket.emit('message:error', { error: error.message });
      }
    });

    // Remove reaction (real-time)
    socket.on('remove_reaction', async (data: { messageId: string; conversationId: string; reaction: string }) => {
      try {
        const { messageId, conversationId, reaction } = data;

        // Delete reaction
        await query(
          `DELETE FROM message_reactions 
           WHERE message_id = $1 AND user_id = $2 AND reaction = $3`,
          [messageId, userId, reaction]
        );

        // Emit to conversation room
        io.to(conversationId).emit('message_reaction_removed', {
          messageId,
          userId,
          reaction,
        });
      } catch (error: any) {
        socket.emit('message:error', { error: error.message });
      }
    });

    socket.on('disconnect', (reason: string) => {
      console.log('[socket] user disconnected', { userId, socketId, reason });
      const wasLastSocket = unregisterUserSocket(userId, socketId);
      if (wasLastSocket) {
        socket.broadcast.emit('user_offline', { userId });
        io.emit('online_users', { userIds: getOnlineUserIds() });
      }
    });
  });
};

