import { query } from '../config/database';
import { v4 as uuidv4 } from 'uuid';
import { Message, MessageStatus, MessageType, MessageVisibilityMode } from '../../../shared/src/types';
import { handleTaskMentionInPersonalChat } from './taskMentionService';
import { getFileUrl, deleteFile } from './mediaUploadService';

/**
 * Forward a message to another conversation
 */
export const forwardMessage = async (
  messageId: string,
  senderId: string,
  receiverId: string | null,
  groupId: string | null,
  senderOrganizationId: string
): Promise<Message> => {
  if (!receiverId && !groupId) {
    throw new Error('Either receiverId or groupId must be provided');
  }

  // Get the original message
  const originalResult = await query(
    `SELECT * FROM messages WHERE id = $1 AND deleted_at IS NULL`,
    [messageId]
  );

  if (originalResult.rows.length === 0) {
    throw new Error('Message not found');
  }

  const originalMessage = originalResult.rows[0];

  // Create forwarded message
  const result = await query(
    `INSERT INTO messages (
      id, sender_id, receiver_id, group_id, message_type, content, media_url,
      file_name, file_size, mime_type, visibility_mode, sender_organization_id,
      forwarded_from_message_id, mentions, task_mentions,
      media_thumbnail, duration, location_lat, location_lng, location_address,
      is_live_location, live_location_expires_at
    )
    VALUES (
      gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
      $15, $16, $17, $18, $19, $20, $21
    )
    RETURNING *`,
    [
      senderId,
      receiverId,
      groupId,
      originalMessage.message_type,
      originalMessage.content,
      originalMessage.media_url,
      originalMessage.file_name,
      originalMessage.file_size,
      originalMessage.mime_type,
      groupId ? 'shared_to_group' : 'shared_to_group',
      senderOrganizationId,
      messageId, // forwarded_from_message_id
      originalMessage.mentions || '[]',
      originalMessage.task_mentions || '[]',
      originalMessage.media_thumbnail,
      originalMessage.duration,
      originalMessage.location_lat,
      originalMessage.location_lng,
      originalMessage.location_address,
      originalMessage.is_live_location || false,
      originalMessage.live_location_expires_at,
    ]
  );

  const message = result.rows[0];

  // Create initial 'sent' status for sender
  await query(
    `INSERT INTO message_status (id, message_id, user_id, status, status_at)
     VALUES (gen_random_uuid(), $1, $2, 'sent', NOW())`,
    [message.id, senderId]
  );

  // If it's a one-to-one message, mark as delivered to receiver
  if (receiverId) {
    await query(
      `INSERT INTO message_status (id, message_id, user_id, status, status_at)
       VALUES (gen_random_uuid(), $1, $2, 'delivered', NOW())
       ON CONFLICT (message_id, user_id) DO UPDATE SET status = 'delivered', status_at = NOW()`,
      [message.id, receiverId]
    );
  }

  return {
    ...message,
    mentions: typeof message.mentions === 'string' ? JSON.parse(message.mentions) : message.mentions,
    taskMentions: typeof message.task_mentions === 'string' ? JSON.parse(message.task_mentions) : message.task_mentions,
  } as Message;
};

/**
 * Create a new message (enhanced with all fields)
 */
export const createMessage = async (
  senderId: string,
  receiverId: string | null,
  groupId: string | null,
  messageType: MessageType,
  content: string | null,
  mediaUrl: string | null,
  fileName: string | null,
  fileSize: number | null,
  mimeType: string | null,
  visibilityMode: MessageVisibilityMode,
  senderOrganizationId: string | null, // Can be NULL for direct messages, required for group messages
  replyToMessageId: string | null = null,
  forwardedFromMessageId: string | null = null,
  mentions: string[] = [],
  taskMentions: string[] = [],
  // New optional fields
  mediaThumbnail: string | null = null,
  duration: number | null = null,
  locationLat: number | null = null,
  locationLng: number | null = null,
  locationAddress: string | null = null,
  isLiveLocation: boolean = false,
  liveLocationExpiresAt: Date | null = null,
  createdAt?: Date
): Promise<Message> => {
  if (!receiverId && !groupId) {
    throw new Error('Either receiverId or groupId must be provided');
  }

  // Validate: organizationId is required for group messages
  if (groupId && !senderOrganizationId) {
    throw new Error('senderOrganizationId is required for group messages');
  }

  const effectiveCreatedAt = createdAt || new Date();

  const result = await query(
    `INSERT INTO messages (
      id, sender_id, receiver_id, group_id, message_type, content, media_url,
      file_name, file_size, mime_type, visibility_mode, sender_organization_id,
      reply_to_message_id, forwarded_from_message_id, mentions, task_mentions,
      media_thumbnail, duration, location_lat, location_lng, location_address,
      is_live_location, live_location_expires_at, created_at
    )
    VALUES (
      gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20, $21, $22, $23
    )
    RETURNING *`,
    [
      senderId,
      receiverId,
      groupId,
      messageType,
      content,
      mediaUrl,
      fileName,
      fileSize,
      mimeType,
      visibilityMode,
      senderOrganizationId,
      replyToMessageId,
      forwardedFromMessageId,
      JSON.stringify(mentions),
      JSON.stringify(taskMentions),
      mediaThumbnail,
      duration,
      locationLat,
      locationLng,
      locationAddress,
      isLiveLocation,
      liveLocationExpiresAt,
      effectiveCreatedAt,
    ]
  );

  const message = result.rows[0];

  // Handle task mentions in personal chat - cross-post to task groups
  if (receiverId && taskMentions.length > 0) {
    // This is a personal chat with task mentions
    await handleTaskMentionInPersonalChat(
      message.id,
      senderId,
      receiverId,
      taskMentions,
      content || '',
      senderOrganizationId
    );
  }

  // Create initial 'sent' status for sender
  await query(
    `INSERT INTO message_status (id, message_id, user_id, status, status_at)
     VALUES (gen_random_uuid(), $1, $2, 'sent', NOW())`,
    [message.id, senderId]
  );

  // If it's a one-to-one message, mark as delivered to receiver
  if (receiverId) {
    await query(
      `INSERT INTO message_status (id, message_id, user_id, status, status_at)
       VALUES (gen_random_uuid(), $1, $2, 'delivered', NOW())`,
      [message.id, receiverId]
    );
  } else if (groupId) {
    // For group messages, mark as delivered to all group members except sender
    const membersResult = await query(
      `SELECT user_id FROM group_members WHERE group_id = $1 AND user_id != $2`,
      [groupId, senderId]
    );

    for (const member of membersResult.rows) {
      await query(
        `INSERT INTO message_status (id, message_id, user_id, status, status_at)
         VALUES (gen_random_uuid(), $1, $2, 'delivered', NOW())`,
        [message.id, member.user_id]
      );
    }
  }

  return {
    ...message,
    mentions: typeof message.mentions === 'string' ? JSON.parse(message.mentions) : message.mentions,
    taskMentions: typeof message.task_mentions === 'string' ? JSON.parse(message.task_mentions) : message.task_mentions,
  } as Message;
};

/**
 * Create a message in a conversation (by conversation_id). Used for task-group and other conversation-based chats.
 * Caller must ensure the user is a member of the conversation.
 */
export const createMessageByConversationId = async (
  conversationId: string,
  senderId: string,
  messageType: MessageType,
  content: string | null,
  senderOrganizationId: string | null = null,
  visibilityMode: MessageVisibilityMode = 'shared_to_group',
  replyToMessageId: string | null = null,
  mediaUrl: string | null = null,
  mediaThumbnail: string | null = null,
  fileName: string | null = null,
  fileSize: number | null = null,
  duration: number | null = null
): Promise<Message> => {
  const result = await query(
    `INSERT INTO messages (
      conversation_id, sender_id, content, message_type, media_url, media_thumbnail,
      file_name, file_size, duration, reply_to_message_id,
      receiver_id, sender_organization_id, visibility_mode, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $12, CURRENT_TIMESTAMP)
    RETURNING *`,
    [
      conversationId,
      senderId,
      content,
      messageType,
      mediaUrl,
      mediaThumbnail,
      fileName,
      fileSize,
      duration,
      replyToMessageId,
      senderOrganizationId,
      visibilityMode,
    ]
  );

  const message = result.rows[0];

  // Create initial 'sent' status for sender
  await query(
    `INSERT INTO message_status (id, message_id, user_id, status, status_at)
     VALUES (gen_random_uuid(), $1, $2, 'sent', NOW())`,
    [message.id, senderId]
  );

  return {
    ...message,
    mentions: typeof message.mentions === 'string' ? JSON.parse(message.mentions || '[]') : (message.mentions || []),
    taskMentions: typeof message.task_mentions === 'string' ? JSON.parse(message.task_mentions || '[]') : (message.task_mentions || []),
  } as Message;
};

/**
 * Get messages for a chat (one-to-one or group) with reactions and reply info
 */
export const getMessages = async (
  userId: string,
  receiverId: string | null,
  groupId: string | null,
  limit: number = 50,
  before: string | null = null
): Promise<any[]> => {
  if (!receiverId && !groupId) {
    throw new Error('Either receiverId or groupId must be provided');
  }

  let queryText = '';
  let params: any[] = [];

  if (receiverId) {
    // One-to-one messages with reactions and reply info
    queryText = `
      SELECT 
        m.*,
        u.name as sender_name,
        u.profile_photo_url as sender_photo,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', mr.id,
                'user_id', mr.user_id,
                'reaction', mr.reaction,
                'created_at', mr.created_at
              )
            )
            FROM message_reactions mr
            WHERE mr.message_id = m.id
          ),
          '[]'::json
        ) as reactions,
        CASE 
          WHEN m.reply_to_message_id IS NOT NULL THEN
            (
              SELECT json_build_object(
                'id', rm.id,
                'sender_id', rm.sender_id,
                'content', rm.content,
                'message_type', rm.message_type,
                'sender_name', ru.name
              )
              FROM messages rm
              LEFT JOIN users ru ON rm.sender_id = ru.id
              WHERE rm.id = m.reply_to_message_id
            )
          ELSE NULL
        END as reply_to,
        ms.status
      FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = $1
      WHERE (
        (m.sender_id = $1 AND m.receiver_id = $2) OR
        (m.sender_id = $2 AND m.receiver_id = $1)
      )
      AND (m.deleted_at IS NULL OR m.deleted_for_everyone = false OR m.sender_id = $1)
      ${before ? 'AND m.created_at < $3' : ''}
      ORDER BY m.created_at DESC
      LIMIT ${before ? '$4' : '$3'}
    `;
    params = before ? [userId, receiverId, before, limit] : [userId, receiverId, limit];
  } else {
    // Group messages - filter by visibility mode with reactions and reply info
    queryText = `
      SELECT 
        m.*,
        u.name as sender_name,
        u.profile_photo_url as sender_photo,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', mr.id,
                'user_id', mr.user_id,
                'reaction', mr.reaction,
                'created_at', mr.created_at
              )
            )
            FROM message_reactions mr
            WHERE mr.message_id = m.id
          ),
          '[]'::json
        ) as reactions,
        CASE 
          WHEN m.reply_to_message_id IS NOT NULL THEN
            (
              SELECT json_build_object(
                'id', rm.id,
                'sender_id', rm.sender_id,
                'content', rm.content,
                'message_type', rm.message_type,
                'sender_name', ru.name
              )
              FROM messages rm
              LEFT JOIN users ru ON rm.sender_id = ru.id
              WHERE rm.id = m.reply_to_message_id
            )
          ELSE NULL
        END as reply_to,
        ms.status
      FROM messages m
      INNER JOIN group_members gm ON m.group_id = gm.group_id
      LEFT JOIN users u ON m.sender_id = u.id
      LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = $2
      WHERE m.group_id = $1
      AND gm.user_id = $2
      AND (m.deleted_at IS NULL OR m.deleted_for_everyone = false OR m.sender_id = $2)
      AND (
        m.visibility_mode = 'shared_to_group' OR
        (m.visibility_mode = 'org_only' AND m.sender_organization_id = gm.organization_id)
      )
      ${before ? 'AND m.created_at < $3' : ''}
      ORDER BY m.created_at DESC
      LIMIT ${before ? '$4' : '$3'}
    `;
    params = before ? [groupId, userId, before, limit] : [groupId, userId, limit];
  }

  const result = await query(queryText, params);

  // Reverse to chronological order
  return result.rows.reverse().map((row: any) => ({
    id: row.id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    receiver_id: row.receiver_id || undefined,
    group_id: row.group_id || undefined,
    message_type: row.message_type,
    content: row.content || undefined,
    media_url: row.media_url ? getFileUrl(row.media_url) : undefined,
    media_thumbnail: row.media_thumbnail || undefined,
    file_name: row.file_name || undefined,
    file_size: row.file_size !== null && row.file_size !== undefined ? Number(row.file_size) : undefined,
    mime_type: row.mime_type || undefined,
    duration: row.duration || undefined,
    visibility_mode: row.visibility_mode,
    sender_organization_id: row.sender_organization_id,
    reply_to_message_id: row.reply_to_message_id || undefined,
    reply_to: row.reply_to || undefined,
    forwarded_from_message_id: row.forwarded_from_message_id || undefined,
    is_edited: row.is_edited,
    edited_at: row.edited_at || undefined,
    deleted_at: row.deleted_at || undefined,
    deleted_for_everyone: row.deleted_for_everyone,
    is_pinned: row.is_pinned,
    is_starred: row.is_starred,
    location_lat: row.location_lat || undefined,
    location_lng: row.location_lng || undefined,
    location_address: row.location_address || undefined,
    is_live_location: row.is_live_location || false,
    live_location_expires_at: row.live_location_expires_at || undefined,
    mentions: typeof row.mentions === 'string' ? JSON.parse(row.mentions) : row.mentions,
    task_mentions: typeof row.task_mentions === 'string' ? JSON.parse(row.task_mentions) : row.task_mentions,
    sender_name: row.sender_name,
    sender_photo: row.sender_photo,
    reactions: typeof row.reactions === 'string' ? JSON.parse(row.reactions) : row.reactions,
    status: row.status || 'sent',
    created_at: row.created_at?.toISOString?.() || new Date(row.created_at).toISOString?.() || new Date().toISOString(),
    updated_at: row.updated_at?.toISOString?.() || new Date(row.updated_at).toISOString?.() || new Date().toISOString(),
  }));
};

/**
 * Update message status (delivered/read)
 */
export const updateMessageStatus = async (
  messageId: string,
  userId: string,
  status: MessageStatus
): Promise<void> => {
  // Check if status record exists
  const existingResult = await query(
    `SELECT id FROM message_status 
     WHERE message_id = $1 AND user_id = $2`,
    [messageId, userId]
  );

  if (existingResult.rows.length > 0) {
    // Update existing status
    await query(
      `UPDATE message_status 
       SET status = $1, status_at = NOW()
       WHERE message_id = $2 AND user_id = $3`,
      [status, messageId, userId]
    );
  } else {
    // Create new status record
    await query(
      `INSERT INTO message_status (id, message_id, user_id, status, status_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW())`,
      [messageId, userId, status]
    );
  }
};

/**
 * Mark messages as read
 */
export const markMessagesAsRead = async (
  userId: string,
  receiverId: string | null,
  groupId: string | null
): Promise<void> => {
  if (!receiverId && !groupId) {
    throw new Error('Either receiverId or groupId must be provided');
  }

  let queryText = '';
  let params: any[] = [];

  if (receiverId) {
    queryText = `
      UPDATE message_status ms
      SET status = 'read', status_at = NOW()
      FROM messages m
      WHERE ms.message_id = m.id
      AND m.sender_id = $1
      AND m.receiver_id = $2
      AND ms.user_id = $2
      AND ms.status != 'read'
    `;
    params = [receiverId, userId];
  } else {
    queryText = `
      UPDATE message_status ms
      SET status = 'read', status_at = NOW()
      FROM messages m
      WHERE ms.message_id = m.id
      AND m.group_id = $1
      AND ms.user_id = $2
      AND ms.status != 'read'
    `;
    params = [groupId, userId];
  }

  await query(queryText, params);
};

/**
 * Edit a message
 */
export const editMessage = async (
  messageId: string,
  userId: string,
  newContent: string
): Promise<Message> => {
  // Verify message exists, belongs to user, and is not deleted
  const checkResult = await query(
    `SELECT id FROM messages 
     WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL`,
    [messageId, userId]
  );

  if (checkResult.rows.length === 0) {
    throw new Error('Message not found, unauthorized, or deleted');
  }

  const result = await query(
    `UPDATE messages 
     SET content = $1, is_edited = true, edited_at = NOW(), updated_at = NOW()
     WHERE id = $2 AND sender_id = $3
     RETURNING *`,
    [newContent, messageId, userId]
  );

  const message = result.rows[0];
  return {
    ...message,
    mentions: typeof message.mentions === 'string' ? JSON.parse(message.mentions) : message.mentions,
    taskMentions: typeof message.task_mentions === 'string' ? JSON.parse(message.task_mentions) : message.task_mentions,
  } as Message;
};

/**
 * Delete a message
 */
export const deleteMessage = async (
  messageId: string,
  userId: string,
  deleteForEveryone: boolean = false
): Promise<void> => {
  // Verify message exists and belongs to user; get media_url for file cleanup
  const checkResult = await query(
    `SELECT id, media_url FROM messages WHERE id = $1 AND sender_id = $2`,
    [messageId, userId]
  );

  if (checkResult.rows.length === 0) {
    throw new Error('Message not found or unauthorized');
  }

  const mediaUrl = checkResult.rows[0].media_url;

  if (deleteForEveryone) {
    await query(
      `UPDATE messages 
       SET deleted_at = NOW(), deleted_for_everyone = true, updated_at = NOW()
       WHERE id = $1 AND sender_id = $2`,
      [messageId, userId]
    );
  } else {
    // Soft delete for sender only
    await query(
      `UPDATE messages 
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND sender_id = $2`,
      [messageId, userId]
    );
  }

  if (mediaUrl && typeof mediaUrl === 'string') {
    try {
      await deleteFile(mediaUrl);
    } catch (err) {
      console.error('Error deleting message media file:', err);
    }
  }
};

/**
 * Pin/unpin a message
 */
export const togglePinMessage = async (
  messageId: string,
  groupId: string,
  userId: string,
  isPinned: boolean
): Promise<void> => {
  // Check if user is group admin
  const memberResult = await query(
    `SELECT role FROM group_members 
     WHERE group_id = $1 AND user_id = $2`,
    [groupId, userId]
  );

  if (memberResult.rows.length === 0) {
    throw new Error('User is not a member of this group');
  }

  await query(
    `UPDATE messages 
     SET is_pinned = $1, updated_at = NOW()
     WHERE id = $2 AND group_id = $3`,
    [isPinned, messageId, groupId]
  );
};

/**
 * Star a message (using starred_messages table)
 */
export const starMessage = async (
  messageId: string,
  userId: string
): Promise<void> => {
  await query(
    `INSERT INTO starred_messages (id, user_id, message_id, created_at)
     VALUES (gen_random_uuid(), $1, $2, NOW())
     ON CONFLICT (user_id, message_id) DO NOTHING`,
    [userId, messageId]
  );
};

/**
 * Unstar a message
 */
export const unstarMessage = async (
  messageId: string,
  userId: string
): Promise<void> => {
  await query(
    `DELETE FROM starred_messages 
     WHERE user_id = $1 AND message_id = $2`,
    [userId, messageId]
  );
};

/**
 * Get all starred messages for a user
 */
export const getStarredMessages = async (userId: string): Promise<any[]> => {
  const result = await query(
    `SELECT 
      m.*,
      u.name as sender_name,
      u.profile_photo_url as sender_photo,
      CASE 
        WHEN m.receiver_id IS NOT NULL THEN 'direct_' || m.receiver_id
        WHEN m.group_id IS NOT NULL THEN 'group_' || m.group_id
      END as conversation_id
    FROM starred_messages sm
    INNER JOIN messages m ON sm.message_id = m.id
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE sm.user_id = $1
    AND m.deleted_at IS NULL
    ORDER BY sm.created_at DESC`,
    [userId]
  );

  return result.rows.map((row: any) => ({
    id: row.id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    receiver_id: row.receiver_id || undefined,
    group_id: row.group_id || undefined,
    message_type: row.message_type,
    content: row.content || undefined,
    media_url: row.media_url ? getFileUrl(row.media_url) : undefined,
    sender_name: row.sender_name,
    sender_photo: row.sender_photo,
    created_at: row.created_at?.toISOString?.() || new Date(row.created_at).toISOString?.() || new Date().toISOString(),
  }));
};

/**
 * Search messages using message_search table (full-text search)
 */
export const searchMessages = async (
  userId: string,
  searchQuery: string,
  conversationId: string | null = null,
  limit: number = 50
): Promise<any[]> => {
  if (!searchQuery || searchQuery.trim().length === 0) {
    throw new Error('Search query is required');
  }

  let queryText = '';
  let params: any[] = [];

  // Use PostgreSQL full-text search
  const tsQuery = searchQuery.trim().split(/\s+/).join(' & ');

  if (conversationId) {
    // Conversation-level search - check membership
    const membershipCheck = await query(
      `SELECT 1 FROM conversation_members 
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId]
    );

    if (membershipCheck.rows.length === 0) {
      throw new Error('Not a member of this conversation');
    }

    queryText = `
      SELECT 
        m.*,
        u.name as sender_name,
        u.profile_photo_url as sender_photo
      FROM message_search ms
      INNER JOIN messages m ON ms.message_id = m.id
      LEFT JOIN users u ON m.sender_id = u.id
      WHERE ms.conversation_id = $1
      AND ms.content_tsvector @@ plainto_tsquery('english', $2)
      AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT $3
    `;
    params = [conversationId, searchQuery, limit];
  } else {
    // Global search - only in conversations where user is a member
    queryText = `
      SELECT DISTINCT
        m.*,
        u.name as sender_name,
        u.profile_photo_url as sender_photo,
        ms.conversation_id
      FROM message_search ms
      INNER JOIN messages m ON ms.message_id = m.id
      INNER JOIN conversation_members cm ON ms.conversation_id = cm.conversation_id
      LEFT JOIN users u ON m.sender_id = u.id
      WHERE cm.user_id = $1
      AND ms.content_tsvector @@ plainto_tsquery('english', $2)
      AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT $3
    `;
    params = [userId, searchQuery, limit];
  }

  const result = await query(queryText, params);

  return result.rows.map((row: any) => ({
    id: row.id,
    conversation_id: row.conversation_id,
    sender_id: row.sender_id,
    receiver_id: row.receiver_id || undefined,
    group_id: row.group_id || undefined,
    message_type: row.message_type,
    content: row.content || undefined,
    media_url: row.media_url ? getFileUrl(row.media_url) : undefined,
    sender_name: row.sender_name,
    sender_photo: row.sender_photo,
    created_at: row.created_at?.toISOString?.() || new Date(row.created_at).toISOString?.() || new Date().toISOString(),
  }));
};

