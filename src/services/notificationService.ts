import { query } from '../config/database';

export interface NotificationData {
  userId: string;
  type: 'message' | 'task_assigned' | 'task_accepted' | 'task_rejected' | 'task_updated' | 'task_overdue' | 'task_escalated' | 'group_member_added' | 'document_shared';
  title: string;
  body?: string;
  conversationId?: string;
  messageId?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}

/**
 * Create a notification for a user
 */
export const createNotification = async (data: NotificationData): Promise<void> => {
  // Map 'message' type to 'message_received' to match database constraint
  const notificationType = data.type === 'message' ? 'message_received' : data.type;
  
  // Use conversationId or messageId as related_entity_id
  const relatedEntityId = data.conversationId || data.messageId || data.relatedEntityId || null;
  const relatedEntityType = data.conversationId ? 'conversation' : (data.messageId ? 'message' : (data.relatedEntityType || null));
  
  await query(
    `INSERT INTO notifications (
      id, user_id, type, title, description, related_entity_type, related_entity_id, is_read, created_at
    )
    VALUES (
      gen_random_uuid(), $1, $2, $3, $4, $5, $6, false, NOW()
    )`,
    [
      data.userId,
      notificationType,
      data.title,
      data.body || null, // Map body to description
      relatedEntityType,
      relatedEntityId,
    ]
  );
};

/**
 * Create message notification for offline users
 */
export const createMessageNotification = async (
  userId: string,
  conversationId: string,
  messageId: string,
  senderName: string,
  messageContent: string | null,
  messageType: string
): Promise<void> => {
  // Generate notification body preview
  let body = '';
  if (messageType === 'text' && messageContent) {
    body = messageContent.length > 50 
      ? messageContent.substring(0, 50) + '...' 
      : messageContent;
  } else {
    // Emoji labels for different message types
    const typeLabels: Record<string, string> = {
      image: '📷 Photo',
      video: '🎥 Video',
      audio: '🎤 Audio',
      voice_note: '🎙️ Voice note',
      document: '📄 Document',
      location: '📍 Location',
      contact: '👤 Contact',
    };
    body = typeLabels[messageType] || 'New message';
  }

  // Get conversation name for title
  let title = senderName;
  if (conversationId.startsWith('group_')) {
    // Try to get group name
    const groupId = conversationId.replace('group_', '');
    const groupResult = await query(
      `SELECT name FROM groups WHERE id = $1`,
      [groupId]
    );
    if (groupResult.rows.length > 0) {
      title = groupResult.rows[0].name || senderName;
    }
  }

  await createNotification({
    userId,
    type: 'message',
    title: `${title}: ${body}`,
    body,
    conversationId,
    messageId,
  });
};

/**
 * Get unread notifications for a user
 */
export const getUnreadNotifications = async (userId: string, limit: number = 50) => {
  const result = await query(
    `SELECT * FROM notifications
     WHERE user_id = $1 AND is_read = false
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
};

/**
 * Mark notification as read
 */
export const markNotificationAsRead = async (notificationId: string, userId: string): Promise<void> => {
  await query(
    `UPDATE notifications
     SET is_read = true, read_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [notificationId, userId]
  );
};

/**
 * Mark all notifications as read for a user
 */
export const markAllNotificationsAsRead = async (userId: string): Promise<void> => {
  await query(
    `UPDATE notifications
     SET is_read = true, read_at = NOW()
     WHERE user_id = $1 AND is_read = false`,
    [userId]
  );
};
