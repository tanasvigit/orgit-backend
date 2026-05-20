import { query } from '../config/database';
import { sendPushToUserIds } from './firebasePushService';

export type NotificationChannel = 'in_app' | 'push' | 'email';

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
  /** Defaults to in_app + push */
  channels?: NotificationChannel[];
  io?: any;
};

/** Map bus types to notifications.type CHECK constraint (see add-phase1-task-lifecycle migration). */
export const mapTypeToDbType = (type: NotificationBusType): string => {
  switch (type) {
    case 'MESSAGE_RECEIVED':
      return 'message_received';
    case 'TASK_ASSIGNED':
      return 'task_assigned';
    case 'TASK_ESCALATED':
      return 'task_escalated';
    case 'TASK_STATUS_CHANGED':
      return 'TASK_STATUS_CHANGED';
    case 'TASK_COMPLETE_PENDING':
      return 'TASK_COMPLETE_PENDING';
    case 'TASK_VERIFIED':
      return 'TASK_VERIFIED';
    case 'TASK_COMPLETION_REJECTED':
      return 'TASK_COMPLETION_REJECTED';
    case 'TASK_DELETED':
      return 'TASK_DELETED';
    case 'EXIT_REQUEST_RECEIVED':
      return 'EXIT_REQUEST_RECEIVED';
    case 'EXIT_APPROVED':
      return 'EXIT_APPROVED';
    case 'EXIT_REJECTED':
      return 'EXIT_REJECTED';
    case 'DELETE_REQUEST_RECEIVED':
      return 'DELETE_REQUEST_RECEIVED';
    case 'MEMBER_ADDED':
      return 'MEMBER_ADDED';
    default:
      return 'task_updated';
  }
};

function buildPushData(input: DispatchNotificationInput): Record<string, string> {
  const data: Record<string, string> = {
    type: input.type,
  };
  if (input.refType) data.refType = String(input.refType);
  if (input.refId) data.refId = String(input.refId);
  if (input.refType === 'conversation' && input.refId) {
    data.conversationId = String(input.refId);
  }
  if (input.type === 'MESSAGE_RECEIVED') {
    data.type = 'message';
    data.isGroup = 'false';
  }
  if (input.refType === 'task') {
    data.isTaskGroup = 'true';
    data.isGroup = 'true';
  }
  return data;
}

export const dispatchNotification = async (
  input: DispatchNotificationInput
): Promise<{ sent: number }> => {
  const recipients = Array.from(new Set((input.recipientIds || []).filter(Boolean)));
  const channels =
    input.channels && input.channels.length > 0 ? input.channels : ['in_app', 'push'];

  if (recipients.length === 0) {
    return { sent: 0 };
  }

  const dbType = mapTypeToDbType(input.type);
  const pushData = buildPushData(input);

  if (channels.includes('in_app')) {
    for (const recipientId of recipients) {
      try {
        const result = await query(
          `INSERT INTO notifications (
            id, user_id, type, title, description, related_entity_type, related_entity_id, is_read, created_at
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6, false, NOW()
          ) RETURNING *`,
          [
            recipientId,
            dbType,
            input.title,
            input.body || null,
            input.refType || null,
            input.refId || null,
          ]
        );

        if (input.io) {
          input.io.to(`user_${recipientId}`).emit('notification:new', result.rows[0]);
        }
      } catch (err: any) {
        console.error(
          `[dispatchNotification] in_app insert failed type=${dbType} user=${recipientId}:`,
          err?.message || err
        );
      }
    }
  }

  if (channels.includes('push')) {
    setImmediate(() => {
      sendPushToUserIds(recipients, input.title, input.body || input.title, pushData).catch(
        (err) => console.warn('[dispatchNotification] push failed:', err?.message || err)
      );
    });
  }

  if (channels.includes('email')) {
    setImmediate(() => {
      // SMTP hook placeholder
    });
  }

  return { sent: recipients.length };
};
