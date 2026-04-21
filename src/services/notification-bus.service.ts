import { query } from '../config/database';

export type NotificationChannel = 'in_app' | 'email';

export type NotificationBusType =
  | 'MESSAGE_RECEIVED'
  | 'TASK_ASSIGNED'
  | 'TASK_ESCALATED'
  | 'TASK_STATUS_CHANGED'
  | 'TASK_COMPLETE_PENDING'
  | 'TASK_VERIFIED'
  | 'TASK_COMPLETION_REJECTED'
  | 'TASK_DELETED'
  | 'EXIT_REQUEST_RECEIVED'
  | 'EXIT_APPROVED'
  | 'EXIT_REJECTED'
  | 'DELETE_REQUEST_RECEIVED'
  | 'MEMBER_ADDED';

type DispatchNotificationInput = {
  type: NotificationBusType;
  recipientIds: string[];
  title: string;
  body?: string;
  refId?: string | null;
  refType?: string | null;
  channels?: NotificationChannel[];
  io?: any;
};

const mapTypeToDbType = (type: NotificationBusType): string => {
  switch (type) {
    case 'MESSAGE_RECEIVED':
      return 'message_received';
    case 'TASK_ASSIGNED':
      return 'task_assigned';
    case 'TASK_ESCALATED':
      return 'task_escalated';
    default:
      return type;
  }
};

export const dispatchNotification = async (
  input: DispatchNotificationInput
): Promise<{ sent: number }> => {
  const recipients = Array.from(new Set((input.recipientIds || []).filter(Boolean)));
  const channels = input.channels && input.channels.length > 0 ? input.channels : ['in_app'];

  if (recipients.length === 0) {
    return { sent: 0 };
  }

  if (channels.includes('in_app')) {
    for (const recipientId of recipients) {
      const result = await query(
        `INSERT INTO notifications (
          id, user_id, type, title, description, related_entity_type, related_entity_id, is_read, created_at
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6, false, NOW()
        ) RETURNING *`,
        [
          recipientId,
          mapTypeToDbType(input.type),
          input.title,
          input.body || null,
          input.refType || null,
          input.refId || null,
        ]
      );

      if (input.io) {
        input.io.to(`user_${recipientId}`).emit('notification:new', result.rows[0]);
      }
    }
  }

  // Keep e-mail async and non-blocking
  if (channels.includes('email')) {
    setImmediate(() => {
      // Placeholder for SMTP integration hook.
    });
  }

  return { sent: recipients.length };
};

