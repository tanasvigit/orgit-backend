import { Request, Response } from 'express';
import { createMessage, createMessageByConversationId, getMessages, editMessage, deleteMessage, togglePinMessage, starMessage, unstarMessage, getStarredMessages, searchMessages, markMessagesAsRead, updateMessageStatus, forwardMessage } from '../services/messageService';
import { query } from '../config/database';
import { getFileUrl, uploadMessageMediaToStorage } from '../services/mediaUploadService';

/**
 * Send a message
 */
export const sendMessage = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const organizationId = (req as any).user?.organizationId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

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
    } = req.body;

    // Support both camelCase and snake_case (APIs/tasks often return conversation_id)
    const conversationId = req.body.conversationId ?? req.body.conversation_id;

    const io = (req as any).app?.get('io');

    // Conversation-based send (task-group or other conversation chats)
    if (conversationId) {
      const memberCheck = await query(
        'SELECT 1 FROM conversation_members WHERE conversation_id::text = $1::text AND user_id = $2',
        [conversationId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({
          success: false,
          error: 'Not a member of this conversation',
        });
      }
      const senderOrganizationId = organizationId || null;
      const message = await createMessageByConversationId(
        conversationId,
        userId,
        messageType,
        content || null,
        senderOrganizationId,
        ['org_only', 'shared_to_group'].includes(visibilityMode) ? visibilityMode : 'shared_to_group',
        replyToMessageId || null,
        mediaUrl || null,
        null,
        fileName || null,
        fileSize || null,
        null
      );
      await query(
        'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id::text = $1::text',
        [conversationId]
      );
      if (io) {
        const senderRow = await query('SELECT name, profile_photo_url as profile_photo FROM users WHERE id = $1', [userId]);
        const senderName = senderRow.rows[0]?.name || 'Unknown';
        const senderPhoto = senderRow.rows[0]?.profile_photo || null;
        const payload = {
          ...message,
          conversation_id: conversationId,
          sender_id: userId,
          text: message.content,
          sender_name: senderName,
          sender_photo: senderPhoto,
          status: 'sent',
        };
        io.to(conversationId).emit('new_message', payload);
        const members = await query('SELECT user_id FROM conversation_members WHERE conversation_id::text = $1::text', [conversationId]);
        for (const m of members.rows) {
          io.to(`user_${m.user_id}`).emit('new_message', payload);
          io.to(`user_${m.user_id}`).emit('receive_message', payload);
        }
      }
      return res.json({
        success: true,
        data: message,
      });
    }

    // Legacy: receiverId or groupId
    const isGroupMessage = !!groupId;
    if (isGroupMessage && !organizationId) {
      return res.status(400).json({
        success: false,
        error: 'Organization ID is required for group messages',
      });
    }

    // Validate visibility mode for group messages
    if (groupId && !['org_only', 'shared_to_group'].includes(visibilityMode)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid visibility mode',
      });
    }

    // For direct messages, organizationId can be NULL
    // For group messages, organizationId is required
    const senderOrganizationId = isGroupMessage ? organizationId : null;

    const message = await createMessage(
      userId,
      receiverId || null,
      groupId || null,
      messageType,
      content || null,
      mediaUrl || null,
      fileName || null,
      fileSize || null,
      mimeType || null,
      visibilityMode,
      senderOrganizationId,
      replyToMessageId || null,
      forwardedFromMessageId || null,
      mentions,
      taskMentions
    );

    // Emit real-time so recipients receive without reload (match socket send_message payload)
    if (io) {
      const senderRow = await query('SELECT name, profile_photo_url as profile_photo FROM users WHERE id = $1', [userId]);
      const senderName = senderRow.rows[0]?.name || 'Unknown';
      const senderPhoto = senderRow.rows[0]?.profile_photo || null;
      const payload = {
        ...message,
        sender_id: userId,
        text: message.content,
        sender_name: senderName,
        sender_photo: senderPhoto,
        status: 'sent',
      };
      if (receiverId) {
        io.to(`user_${receiverId}`).emit('new_message', payload);
      }
      if (groupId) {
        const members = await query('SELECT user_id FROM group_members WHERE group_id = $1', [groupId]);
        for (const m of members.rows) {
          if (m.user_id !== userId) io.to(`user_${m.user_id}`).emit('new_message', payload);
        }
      }
    }

    res.json({
      success: true,
      data: message,
    });
  } catch (error: any) {
    console.error('Send message error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to send message',
    });
  }
};

/**
 * Get messages for a chat
 */
export const getChatMessages = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { receiverId, groupId } = req.query;
    const limit = parseInt(req.query.limit as string) || 50;
    const before = req.query.before as string | null;

    if (!receiverId && !groupId) {
      return res.status(400).json({
        success: false,
        error: 'Either receiverId or groupId must be provided',
      });
    }

    const messages = await getMessages(
      userId,
      (receiverId as string) || null,
      (groupId as string) || null,
      limit,
      before
    );

    res.json({
      success: true,
      data: messages,
    });
  } catch (error: any) {
    console.error('Get messages error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get messages',
    });
  }
};

/**
 * Mark messages as read
 */
export const markAsRead = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { receiverId, groupId } = req.body;

    if (!receiverId && !groupId) {
      return res.status(400).json({
        success: false,
        error: 'Either receiverId or groupId must be provided',
      });
    }

    await markMessagesAsRead(
      userId,
      receiverId || null,
      groupId || null
    );

    res.json({
      success: true,
      message: 'Messages marked as read',
    });
  } catch (error: any) {
    console.error('Mark as read error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to mark messages as read',
    });
  }
};

/**
 * Edit a message
 */
export const editMessageHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { messageId } = req.params;
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Content required' });
    }

    // Verify message belongs to user
    const messageCheck = await query(
      'SELECT id FROM messages WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL',
      [messageId, userId]
    );

    if (messageCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Message not found or cannot be edited' });
    }

    await query(
      `UPDATE messages
       SET content = $1, is_edited = true, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [content, messageId]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Edit message error:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
};

/**
 * Delete a message
 */
export const deleteMessageHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { messageId } = req.params;
    const { deleteForAll } = req.body;

    await deleteMessage(messageId, userId, deleteForAll === true);

    res.json({ success: true });
  } catch (error: any) {
    console.error('Delete message error:', error);
    res.status(403).json({ error: error.message || 'Message not found' });
  }
};

/**
 * Pin/unpin a message
 */
export const togglePin = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { messageId } = req.params;
    const { groupId, isPinned } = req.body;

    if (!groupId) {
      return res.status(400).json({
        success: false,
        error: 'groupId is required',
      });
    }

    await togglePinMessage(messageId, groupId, userId, isPinned);

    res.json({
      success: true,
      message: `Message ${isPinned ? 'pinned' : 'unpinned'}`,
    });
  } catch (error: any) {
    console.error('Toggle pin error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to toggle pin',
    });
  }
};

/**
 * Star a message (using starred_messages table)
 */
export const starMessageHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { messageId } = req.params;

    await query(
      `INSERT INTO starred_messages (user_id, message_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, messageId]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Star message error:', error);
    res.status(500).json({ error: 'Failed to star message' });
  }
};

/**
 * Unstar a message
 */
export const unstarMessageHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { messageId } = req.params;

    await query(
      'DELETE FROM starred_messages WHERE user_id = $1 AND message_id = $2',
      [userId, messageId]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Unstar message error:', error);
    res.status(500).json({ error: 'Failed to unstar message' });
  }
};

/**
 * Search messages
 */
export const searchMessagesHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { q, receiverId, groupId } = req.query;
    const limit = parseInt(req.query.limit as string) || 50;

    if (!q) {
      return res.status(400).json({
        success: false,
        error: 'Search query is required',
      });
    }

    // Construct conversationId from receiverId or groupId
    let conversationId: string | null = null;
    if (receiverId) {
      conversationId = `direct_${receiverId}`;
    } else if (groupId) {
      conversationId = `group_${groupId}`;
    }

    const messages = await searchMessages(
      userId,
      q as string,
      conversationId,
      limit
    );

    res.json({
      success: true,
      data: messages,
    });
  } catch (error: any) {
    console.error('Search messages error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to search messages',
    });
  }
};

/**
 * Get messages by conversationId (for mobile app compatibility)
 * Includes reactions and reply info, with membership check
 */
export const getMessagesByConversationId = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    let { conversationId } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        error: 'conversationId is required',
      });
    }

    // CRITICAL FIX: Handle both UUID and "direct_<userId>" format from mobile app
    // Messages are stored with conversation_id in "direct_<userId>" format when sent via socket
    // So we can query directly using the conversationId as-is
    
    // For "direct_" format, verify the user has access (they're one of the two users)
    if (conversationId.startsWith('direct_')) {
      const otherUserId = conversationId.replace('direct_', '');
      
      // Verify this is a conversation between current user and other user
      if (otherUserId !== userId) {
        // Check if messages exist between these two users with this conversation_id
        const messageCheck = await query(
          `SELECT 1 FROM messages 
           WHERE conversation_id = $1 
             AND ((sender_id = $2 AND receiver_id = $3) OR (sender_id = $3 AND receiver_id = $2))
             AND deleted_at IS NULL
           LIMIT 1`,
          [conversationId, userId, otherUserId]
        );
        
        if (messageCheck.rows.length === 0) {
          // No messages exist - return empty (new conversation)
          return res.json({ messages: [] });
        }
      }
    } else {
      // For UUID format, verify user is member
      const memberCheck = await query(
        'SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, userId]
      );

      if (memberCheck.rows.length === 0) {
        // Check if messages exist for this conversation
        const messageCheck = await query(
          `SELECT 1 FROM messages WHERE conversation_id = $1 LIMIT 1`,
          [conversationId]
        );
        
        if (messageCheck.rows.length > 0) {
          // Messages exist, ensure membership
          await query(
            `INSERT INTO conversation_members (conversation_id, user_id)
             VALUES ($1, $2)
             ON CONFLICT (conversation_id, user_id) DO NOTHING`,
            [conversationId, userId]
          );
        } else {
          // New conversation, return empty
          return res.json({ messages: [] });
        }
      }
    }

    // Get messages with reactions and reply info (matching message-backend structure)
    // CRITICAL: Use CAST to handle both TEXT and UUID conversation_id formats
    console.log(`[getMessagesByConversationId] Fetching messages for conversationId: ${conversationId}, userId: ${userId}, limit: ${limit}, offset: ${offset}`);
    
    // Debug: Check what conversation_ids actually exist in the database for this conversation
    const debugCheck = await query(
      `SELECT DISTINCT conversation_id, COUNT(*) as msg_count 
       FROM messages 
       WHERE conversation_id::text LIKE $1 || '%' OR conversation_id::text = $1
       GROUP BY conversation_id`,
      [conversationId]
    );
    console.log(`[getMessagesByConversationId] Debug - Found conversation_ids in DB:`, debugCheck.rows);
    
    // Check if this is a task group conversation
    const convInfoResult = await query(
      `SELECT is_task_group, is_group FROM conversations WHERE id = $1`,
      [conversationId]
    );
    const isTaskGroup = convInfoResult.rows[0]?.is_task_group || false;
    const isGroup = convInfoResult.rows[0]?.is_group || false;
    
    // For task groups and regular groups, all messages should be visible to all members
    // The deleted_at check should be sufficient - no need for visibility_mode filtering
    // Determine viewer's organization (for org-only visibility in group / task-group)
    let viewerOrganizationId: string | null = null;
    try {
      const orgResult = await query(
        `SELECT organization_id 
         FROM user_organizations 
         WHERE user_id = $1 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [userId]
      );
      viewerOrganizationId = orgResult.rows[0]?.organization_id || null;
    } catch (orgErr: any) {
      console.warn(
        '[getMessagesByConversationId] Failed to resolve viewer organization, proceeding without org filter:',
        orgErr.message
      );
      viewerOrganizationId = null;
    }

    const result = await query(
      `SELECT 
        m.id,
        m.conversation_id,
        m.sender_id,
        m.content,
        m.message_type,
        m.media_url,
        m.media_thumbnail,
        m.file_name,
        m.file_size,
        m.mime_type,
        m.duration,
        m.reply_to_message_id,
        m.updated_at,
        m.deleted_at,
        m.deleted_for_all,
        m.location_lat,
        m.location_lng,
        m.location_address,
        m.is_live_location,
        m.visibility_mode,
        m.sender_organization_id,
        m.metadata,
        CASE
          -- If current user is the sender (for task groups / groups)
          WHEN m.sender_id = $2 AND ($5 = true OR $6 = true) THEN
            -- Check if ALL other members (excluding sender) have read the message
            CASE
              WHEN (
                SELECT COUNT(DISTINCT cm.user_id)
                FROM conversation_members cm
                WHERE cm.conversation_id = $1
                  AND cm.user_id != $2
              ) = (
                SELECT COUNT(DISTINCT ms.user_id)
                FROM message_status ms
                WHERE ms.message_id = m.id
                  AND ms.status = 'read'
                  AND ms.user_id != $2
              )
              THEN 'read'
              ELSE 'sent'
            END
          -- If current user is a receiver (use their own read status from message_status)
          ELSE COALESCE(ms.status, 'sent')
        END as status,
        m.created_at,
        u.name as sender_name,
        u.profile_photo_url as sender_photo,
        (
          SELECT COALESCE(json_agg(
            json_build_object(
              'id', mr.id,
              'user_id', mr.user_id,
              'reaction', mr.reaction,
              'user_name', u2.name
            )
          ), '[]'::json)
          FROM message_reactions mr
          JOIN users u2 ON mr.user_id = u2.id
          WHERE mr.message_id = m.id
        ) as reactions,
        (
          SELECT json_build_object(
            'id', rm.id,
            'content', rm.content,
            'sender_name', u3.name,
            'message_type', rm.message_type
          )
          FROM messages rm
          JOIN users u3 ON rm.sender_id = u3.id
          WHERE rm.id = m.reply_to_message_id
        ) as reply_to
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = $2
      WHERE CAST(m.conversation_id AS TEXT) = CAST($1 AS TEXT)
        AND (
          -- Message is not deleted (deleted_at is NULL)
          m.deleted_at IS NULL 
          -- OR message is deleted but sender can still see their own messages
          OR m.sender_id = $2
        )
        AND (
          -- For non-group / non-task-group conversations, all messages are visible
          ($5 = false AND $6 = false)
          OR
          -- For group / task-group conversations, enforce per-message visibility:
          -- - shared_to_group is visible to all members
          -- - org_only is visible only to members whose org matches sender_organization_id
          (
            ($5 = true OR $6 = true)
            AND (
              m.visibility_mode = 'shared_to_group'
              OR (m.visibility_mode = 'org_only' AND m.sender_organization_id = $7)
            )
          )
        )
      ORDER BY m.created_at DESC
      LIMIT $3 OFFSET $4`,
      [conversationId, userId, limit, offset, isTaskGroup, isGroup, viewerOrganizationId]
    );
    
    // Debug: Log message visibility info
    if (result.rows.length > 0) {
      console.log(`[getMessagesByConversationId] Found ${result.rows.length} messages for task group: ${isTaskGroup}, group: ${isGroup}`);
      console.log(`[getMessagesByConversationId] Sample message:`, {
        id: result.rows[0].id,
        sender_id: result.rows[0].sender_id,
        conversation_id: result.rows[0].conversation_id,
        deleted_at: result.rows[0].deleted_at,
        deleted_for_all: result.rows[0].deleted_for_all
      });
    }
    
    console.log(`[getMessagesByConversationId] Query for conversationId: ${conversationId}, userId: ${userId}, found ${result.rows.length} messages`);

    // Match message-backend response format: { messages: [...] }
    // Reverse to show oldest first (chronological order)
    // CRITICAL: Resolve media_url to signed URLs for S3 keys
    const messages = result.rows.reverse().map((msg: any) => ({
      ...msg,
      media_url: msg.media_url ? getFileUrl(msg.media_url) : msg.media_url,
    }));
    console.log(`[getMessagesByConversationId] Returning ${messages.length} messages in chronological order`);
    res.json({ messages });
  } catch (error: any) {
    console.error('[getMessagesByConversationId] Error:', error.message);
    console.error('[getMessagesByConversationId] Stack:', error.stack);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

/**
 * Mark messages as read by conversationId
 * CRITICAL FIX: Works with UUID conversation IDs directly (matching message-backend)
 * Also updates message_status table and emits socket events
 */
export const markMessagesAsReadByConversationId = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { conversationId } = req.params;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        error: 'conversationId is required',
      });
    }

    // Verify user is member
    const memberCheck = await query(
      'SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    // Get Socket.IO instance from app (matching conversationController pattern)
    const io = (req as any).app.get('io');

    // Check if this is a group conversation
    const convInfoResult = await query(
      `SELECT is_group, is_task_group FROM conversations WHERE id::text = $1::text`,
      [conversationId]
    );
    const isGroup = convInfoResult.rows[0]?.is_group || convInfoResult.rows[0]?.is_task_group || false;

    // Read status is in message_status only (messages table has no status column). Same for group and direct.
    const unreadMessages = await query(
      `SELECT m.id 
       FROM messages m
       LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = $2
       WHERE m.conversation_id::text = $1::text 
         AND m.sender_id != $2 
         AND (ms.status IS NULL OR ms.status != 'read')
         AND m.deleted_at IS NULL`,
      [conversationId, userId]
    );

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
          console.warn('[markMessagesAsReadByConversationId] Could not update message_status table:', error.message);
        }
      }
    }

    // Emit socket events to notify all members (matching socket handler implementation)
    if (io) {
      // Get conversation members to emit to their personal rooms
      const convMembers = await query(
        'SELECT user_id FROM conversation_members WHERE conversation_id::text = $1::text',
        [conversationId]
      );

      // Emit a single event for all messages marked as read in this conversation
      io.to(conversationId).emit('conversation_messages_read', {
        conversationId,
        status: 'read',
        userId,
      });

      // Also emit to each member's personal room
      for (const member of convMembers.rows) {
        io.to(`user_${member.user_id}`).emit('conversation_messages_read', {
          conversationId,
          status: 'read',
          userId,
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
             WHERE cm.conversation_id = $1 AND cm.user_id != $2`,
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

    // Match message-backend response format: { success: true }
    res.json({ success: true });
  } catch (error: any) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Add reaction to message
 */
export const addReaction = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { messageId } = req.params;
    const { reaction } = req.body;

    if (!reaction) {
      return res.status(400).json({ error: 'Reaction required' });
    }

    await query(
      `INSERT INTO message_reactions (message_id, user_id, reaction)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id, reaction) DO NOTHING`,
      [messageId, userId, reaction]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Add reaction error:', error);
    res.status(500).json({ error: 'Failed to add reaction' });
  }
};

/**
 * Remove reaction from message
 */
export const removeReaction = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { messageId, reaction } = req.params;

    await query(
      'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND reaction = $3',
      [messageId, userId, reaction]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Remove reaction error:', error);
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
};

/**
 * Get all starred messages (using starred_messages table)
 */
export const getStarredMessagesHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    
    const result = await query(
      `SELECT m.*, u.name as sender_name, c.name as conversation_name
       FROM starred_messages sm
       JOIN messages m ON sm.message_id = m.id
       JOIN users u ON m.sender_id = u.id
       JOIN conversations c ON m.conversation_id = c.id
       WHERE sm.user_id = $1
         AND (m.deleted_at IS NULL OR m.deleted_for_all = FALSE)
       ORDER BY sm.created_at DESC`,
      [userId]
    );

    res.json({ messages: result.rows });
  } catch (error: any) {
    console.error('Get starred messages error:', error);
    res.status(500).json({ error: 'Failed to get starred messages' });
  }
};

/**
 * Search messages in conversation (using message_search table)
 */
export const searchMessagesInConversation = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { conversationId } = req.params; // Optional - can be undefined for global search
    const { query: searchQuery, limit: limitStr } = req.query; // message-backend uses 'query'
    const limit = parseInt(limitStr as string) || 50;

    if (!searchQuery) {
      return res.status(400).json({ error: 'Search query required' });
    }

    let searchQuerySQL: string;
    let params: any[];

    if (conversationId) {
      // Chat-level search
      // Verify user is member
      const memberCheck = await query(
        'SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, userId]
      );

      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Not a member of this conversation' });
      }

      searchQuerySQL = `
        SELECT m.*, u.name as sender_name
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        JOIN message_search ms ON m.id = ms.message_id
        WHERE ms.conversation_id = $1
          AND ms.content_tsvector @@ plainto_tsquery('english', $2)
          AND (m.deleted_at IS NULL OR m.deleted_for_all = FALSE OR m.sender_id = $3)
        ORDER BY m.created_at DESC
        LIMIT $4
      `;
      params = [conversationId, searchQuery, userId, limit];
    } else {
      // Global search (across all user's conversations)
      searchQuerySQL = `
        SELECT m.*, u.name as sender_name, c.name as conversation_name, c.is_group
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        JOIN conversations c ON m.conversation_id = c.id
        JOIN conversation_members cm ON c.id = cm.conversation_id
        JOIN message_search ms ON m.id = ms.message_id
        WHERE cm.user_id = $1
          AND ms.content_tsvector @@ plainto_tsquery('english', $2)
          AND (m.deleted_at IS NULL OR m.deleted_for_all = FALSE OR m.sender_id = $1)
        ORDER BY m.created_at DESC
        LIMIT $3
      `;
      params = [userId, searchQuery, limit];
    }

    const result = await query(searchQuerySQL, params);
    res.json({ messages: result.rows });
  } catch (error: any) {
    console.error('Search messages error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
};

/**
 * Forward a message to another conversation
 */
export const forwardMessageHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const organizationId = (req as any).user?.organizationId;
    const { messageId } = req.params;
    const { receiverId, groupId } = req.body;

    if (!userId || !organizationId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    if (!receiverId && !groupId) {
      return res.status(400).json({
        success: false,
        error: 'Either receiverId or groupId must be provided',
      });
    }

    const message = await forwardMessage(
      messageId,
      userId,
      receiverId || null,
      groupId || null,
      organizationId
    );

    res.json({
      success: true,
      data: message,
    });
  } catch (error: any) {
    console.error('Forward message error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to forward message',
    });
  }
};

/**
 * Upload image for message
 */
async function getUploadResult(file: Express.Multer.File): Promise<{ fileUrl: string; filename: string }> {
  if (file.buffer) {
    return uploadMessageMediaToStorage(file);
  }
  return {
    fileUrl: getFileUrl(file.filename),
    filename: `/uploads/messages/${file.filename}`,
  };
}

export const uploadImage = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      console.error('[uploadImage] No file in request:', {
        hasFile: !!req.file,
        hasFiles: !!req.files,
        body: req.body,
        headers: req.headers,
      });
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
      });
    }

    const { fileUrl, filename } = await getUploadResult(req.file);

    res.json({
      success: true,
      data: {
        url: fileUrl,
        filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      },
    });
  } catch (error: any) {
    console.error('Upload image error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload image',
    });
  }
};

/**
 * Upload video for message
 */
export const uploadVideo = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      console.error('[uploadVideo] No file in request:', {
        hasFile: !!req.file,
        hasFiles: !!req.files,
        body: req.body,
        headers: req.headers,
      });
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
      });
    }

    const { fileUrl, filename } = await getUploadResult(req.file);

    res.json({
      success: true,
      data: {
        url: fileUrl,
        filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      },
    });
  } catch (error: any) {
    console.error('Upload video error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload video',
    });
  }
};

/**
 * Upload audio file for message
 */
export const uploadAudio = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      console.error('[uploadAudio] No file in request:', {
        hasFile: !!req.file,
        hasFiles: !!req.files,
        body: req.body,
        headers: req.headers,
      });
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
      });
    }

    const { fileUrl, filename } = await getUploadResult(req.file);

    res.json({
      success: true,
      data: {
        url: fileUrl,
        filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      },
    });
  } catch (error: any) {
    console.error('Upload audio error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload audio',
    });
  }
};

/**
 * Upload document for message
 */
export const uploadDocument = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      console.error('[uploadDocument] No file in request:', {
        hasFile: !!req.file,
        hasFiles: !!req.files,
        body: req.body,
        headers: req.headers,
      });
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
      });
    }

    const { fileUrl, filename } = await getUploadResult(req.file);

    res.json({
      success: true,
      data: {
        url: fileUrl,
        filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      },
    });
  } catch (error: any) {
    console.error('Upload document error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload document',
    });
  }
};

/**
 * Upload voice note for message
 */
export const uploadVoiceNote = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      console.error('[uploadVoiceNote] No file in request:', {
        hasFile: !!req.file,
        hasFiles: !!req.files,
        body: req.body,
        headers: req.headers,
      });
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
      });
    }

    const { fileUrl, filename } = await getUploadResult(req.file);
    const duration = req.body.duration ? parseInt(req.body.duration) : null;

    res.json({
      success: true,
      data: {
        url: fileUrl,
        filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
        duration,
      },
    });
  } catch (error: any) {
    console.error('Upload voice note error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload voice note',
    });
  }
};

