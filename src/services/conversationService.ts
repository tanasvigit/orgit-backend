import { query } from '../config/database';

export interface Conversation {
  conversationId: string;
  type: 'direct' | 'group';
  otherUserId?: string;
  groupId?: string;
  name?: string;
  photoUrl?: string;
  lastMessage?: {
    id: string;
    content: string;
    messageType: string;
    senderId: string;
    senderName: string;
    createdAt: Date;
  };
  unreadCount: number;
  isPinned: boolean;
  updatedAt: Date;
}

/**
 * Get all conversations for a user (direct chats and groups)
 */
export const getUserConversations = async (userId: string): Promise<Conversation[]> => {
  // Get user's organization
  const orgResult = await query(
    `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  const organizationId = orgResult.rows.length > 0 ? orgResult.rows[0].organization_id : null;

  // Get direct conversations (one-to-one chats)
  const directChatsResult = await query(
    `SELECT DISTINCT
      CASE 
        WHEN m.sender_id = $1 THEN m.receiver_id
        ELSE m.sender_id
      END as other_user_id,
      MAX(m.created_at) as last_message_time
    FROM messages m
    WHERE (m.sender_id = $1 OR m.receiver_id = $1)
      AND m.group_id IS NULL
      AND m.is_deleted = false
    GROUP BY other_user_id
    ORDER BY last_message_time DESC`,
    [userId]
  );

  // Get group conversations
  const groupsResult = await query(
    `SELECT g.id, g.name, g.photo_url, MAX(m.created_at) as last_message_time
    FROM groups g
    INNER JOIN group_members gm ON g.id = gm.group_id
    LEFT JOIN messages m ON m.group_id = g.id AND m.is_deleted = false
    WHERE gm.user_id = $1
    GROUP BY g.id, g.name, g.photo_url
    ORDER BY last_message_time DESC NULLS LAST`,
    [userId]
  );

  const conversations: Conversation[] = [];

  // Process direct chats
  for (const row of directChatsResult.rows) {
    const otherUserId = row.other_user_id;
    
    // Get other user info
    const userResult = await query(
      `SELECT id, name, profile_photo_url FROM users WHERE id = $1`,
      [otherUserId]
    );
    
    if (userResult.rows.length === 0) continue;
    
    const otherUser = userResult.rows[0];
    
    // Get last message
    const lastMessageResult = await query(
      `SELECT m.id, m.content, m.message_type, m.sender_id, m.created_at, u.name as sender_name
      FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      WHERE ((m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1))
        AND m.is_deleted = false
      ORDER BY m.created_at DESC
      LIMIT 1`,
      [userId, otherUserId]
    );
    
    // Get unread count
    const unreadResult = await query(
      `SELECT COUNT(*) as count
      FROM messages m
      LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = $1
      WHERE m.receiver_id = $1
        AND m.sender_id = $2
        AND m.is_deleted = false
        AND (ms.status IS NULL OR ms.status != 'read')`,
      [userId, otherUserId]
    );
    
    const lastMessage = lastMessageResult.rows.length > 0 ? {
      id: lastMessageResult.rows[0].id,
      content: lastMessageResult.rows[0].content || '',
      messageType: lastMessageResult.rows[0].message_type,
      senderId: lastMessageResult.rows[0].sender_id,
      senderName: lastMessageResult.rows[0].sender_name || 'Unknown',
      createdAt: lastMessageResult.rows[0].created_at,
    } : undefined;
    
    conversations.push({
      conversationId: `direct_${otherUserId}`,
      type: 'direct',
      otherUserId: otherUserId,
      name: otherUser.name,
      photoUrl: otherUser.profile_photo_url,
      lastMessage,
      unreadCount: parseInt(unreadResult.rows[0].count) || 0,
      isPinned: false, // TODO: Implement pinning for direct chats
      updatedAt: lastMessage?.createdAt || new Date(),
    });
  }
  
  // Process group chats
  for (const row of groupsResult.rows) {
    const groupId = row.id;
    
    // Get last message
    const lastMessageResult = await query(
      `SELECT m.id, m.content, m.message_type, m.sender_id, m.created_at, u.name as sender_name
      FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      INNER JOIN group_members gm ON m.group_id = gm.group_id
      WHERE m.group_id = $1
        AND gm.user_id = $2
        AND m.is_deleted = false
        AND (
          m.visibility_mode = 'shared_to_group' OR
          (m.visibility_mode = 'org_only' AND m.sender_organization_id = gm.organization_id)
        )
      ORDER BY m.created_at DESC
      LIMIT 1`,
      [groupId, userId]
    );
    
    // Get unread count
    const unreadResult = await query(
      `SELECT COUNT(*) as count
      FROM messages m
      LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = $2
      INNER JOIN group_members gm ON m.group_id = gm.group_id
      WHERE m.group_id = $1
        AND gm.user_id = $2
        AND m.is_deleted = false
        AND m.sender_id != $2
        AND (
          m.visibility_mode = 'shared_to_group' OR
          (m.visibility_mode = 'org_only' AND m.sender_organization_id = gm.organization_id)
        )
        AND (ms.status IS NULL OR ms.status != 'read')`,
      [groupId, userId]
    );
    
    const lastMessage = lastMessageResult.rows.length > 0 ? {
      id: lastMessageResult.rows[0].id,
      content: lastMessageResult.rows[0].content || '',
      messageType: lastMessageResult.rows[0].message_type,
      senderId: lastMessageResult.rows[0].sender_id,
      senderName: lastMessageResult.rows[0].sender_name || 'Unknown',
      createdAt: lastMessageResult.rows[0].created_at,
    } : undefined;
    
    conversations.push({
      conversationId: `group_${groupId}`,
      type: 'group',
      groupId: groupId,
      name: row.name,
      photoUrl: row.photo_url,
      lastMessage,
      unreadCount: parseInt(unreadResult.rows[0].count) || 0,
      isPinned: false, // TODO: Implement pinning for groups
      updatedAt: lastMessage?.createdAt || new Date(),
    });
  }
  
  // Sort by updatedAt descending
  conversations.sort((a, b) => {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  
  return conversations;
};

/**
 * Get conversation details
 */
export const getConversationDetails = async (
  userId: string,
  conversationId: string
): Promise<Conversation | null> => {
  if (conversationId.startsWith('direct_')) {
    const otherUserId = conversationId.replace('direct_', '');
    
    // Verify user has access to this conversation
    const messageCheck = await query(
      `SELECT COUNT(*) as count
      FROM messages
      WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
        AND group_id IS NULL
        AND is_deleted = false
      LIMIT 1`,
      [userId, otherUserId]
    );
    
    if (parseInt(messageCheck.rows[0].count) === 0) {
      return null;
    }
    
    const userResult = await query(
      `SELECT id, name, profile_photo_url FROM users WHERE id = $1`,
      [otherUserId]
    );
    
    if (userResult.rows.length === 0) return null;
    
    const otherUser = userResult.rows[0];
    
    return {
      conversationId,
      type: 'direct',
      otherUserId: otherUserId,
      name: otherUser.name,
      photoUrl: otherUser.profile_photo_url,
      unreadCount: 0,
      isPinned: false,
      updatedAt: new Date(),
    };
  } else if (conversationId.startsWith('group_')) {
    const groupId = conversationId.replace('group_', '');
    
    // Verify user is member of this group
    const memberCheck = await query(
      `SELECT COUNT(*) as count
      FROM group_members
      WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );
    
    if (parseInt(memberCheck.rows[0].count) === 0) {
      return null;
    }
    
    const groupResult = await query(
      `SELECT id, name, photo_url FROM groups WHERE id = $1`,
      [groupId]
    );
    
    if (groupResult.rows.length === 0) return null;
    
    const group = groupResult.rows[0];
    
    return {
      conversationId,
      type: 'group',
      groupId: groupId,
      name: group.name,
      photoUrl: group.photo_url,
      unreadCount: 0,
      isPinned: false,
      updatedAt: new Date(),
    };
  }
  
  return null;
};

/**
 * Create or get direct conversation
 */
export const createOrGetDirectConversation = async (
  userId: string,
  otherUserId: string
): Promise<string> => {
  // Check if conversation already exists (has messages)
  const existingResult = await query(
    `SELECT COUNT(*) as count
    FROM messages
    WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
      AND group_id IS NULL
      AND is_deleted = false
    LIMIT 1`,
    [userId, otherUserId]
  );
  
  // Conversation exists if there are messages
  if (parseInt(existingResult.rows[0].count) > 0) {
    return `direct_${otherUserId}`;
  }
  
  // Return conversation ID (conversation will be created when first message is sent)
  return `direct_${otherUserId}`;
};

