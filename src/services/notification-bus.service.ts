import { query } from '../config/database';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  EmployeeNotificationSettings,
  normalizeNotificationSettings,
} from './employeeMasterCatalog';
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
  /** Task group chat message — sets isTaskGroup on FCM data payload */
  isTaskGroup?: boolean;
  /** Conversation UUID for chat push deep links */
  conversationId?: string | null;
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
  const conversationId =
    input.conversationId ||
    (input.refType === 'conversation' && input.refId ? input.refId : null);
  if (conversationId) {
    data.conversationId = String(conversationId);
  }
  if (input.type === 'MESSAGE_RECEIVED') {
    data.type = 'message';
    data.isGroup = input.isTaskGroup ? 'true' : 'false';
  }
  if (input.isTaskGroup) {
    data.isTaskGroup = 'true';
    data.isGroup = 'true';
  } else if (input.refType === 'task' && input.type === 'MESSAGE_RECEIVED') {
    data.isTaskGroup = 'true';
    data.isGroup = 'true';
  } else if (input.refType === 'task' && input.refId) {
    data.isTaskGroup = 'false';
    data.isGroup = 'false';
  }
  return data;
}

const TASK_REMINDER_TYPES: NotificationBusType[] = [
  'TASK_ASSIGNED',
  'TASK_STATUS_CHANGED',
  'TASK_COMPLETE_PENDING',
  'TASK_VERIFIED',
  'TASK_COMPLETION_REJECTED',
  'TASK_DELETED',
];

async function loadNotificationSettingsForUsers(
  userIds: string[]
): Promise<Map<string, EmployeeNotificationSettings>> {
  const map = new Map<string, EmployeeNotificationSettings>();
  if (userIds.length === 0) return map;

  const result = await query(
    `SELECT uo.user_id, uo.notification_settings
     FROM user_organizations uo
     WHERE uo.user_id = ANY($1::uuid[])`,
    [userIds]
  );

  for (const row of result.rows) {
    map.set(
      String(row.user_id),
      normalizeNotificationSettings(row.notification_settings)
    );
  }

  for (const id of userIds) {
    if (!map.has(id)) {
      map.set(id, normalizeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS));
    }
  }

  return map;
}

function isNotificationTypeEnabled(
  type: NotificationBusType,
  settings: EmployeeNotificationSettings
): boolean {
  if (type === 'TASK_ESCALATED') {
    return settings.escalationAlerts;
  }
  if (TASK_REMINDER_TYPES.includes(type)) {
    return settings.taskReminders;
  }
  return settings.inApp;
}

function resolveChannelsForRecipient(
  requestedChannels: NotificationChannel[],
  settings: EmployeeNotificationSettings,
  type: NotificationBusType
): NotificationChannel[] {
  if (!isNotificationTypeEnabled(type, settings)) {
    return [];
  }

  return requestedChannels.filter((channel) => {
    if (channel === 'in_app' || channel === 'push') return settings.inApp;
    if (channel === 'email') return settings.email;
    return true;
  });
}

export const dispatchNotification = async (
  input: DispatchNotificationInput
): Promise<{ sent: number }> => {
  const recipients = Array.from(new Set((input.recipientIds || []).filter(Boolean)));
  const requestedChannels =
    input.channels && input.channels.length > 0 ? input.channels : ['in_app', 'push'];

  if (recipients.length === 0) {
    return { sent: 0 };
  }

  const settingsByUser = await loadNotificationSettingsForUsers(recipients);
  const dbType = mapTypeToDbType(input.type);
  const pushData = buildPushData(input);

  const inAppRecipients: string[] = [];
  const pushRecipients: string[] = [];
  const emailRecipients: string[] = [];

  for (const recipientId of recipients) {
    const settings =
      settingsByUser.get(recipientId) ??
      normalizeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS);
    const channels = resolveChannelsForRecipient(requestedChannels, settings, input.type);

    if (channels.includes('in_app')) inAppRecipients.push(recipientId);
    if (channels.includes('push')) pushRecipients.push(recipientId);
    if (channels.includes('email')) emailRecipients.push(recipientId);
  }

  if (inAppRecipients.length > 0) {
    for (const recipientId of inAppRecipients) {
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

  if (pushRecipients.length > 0) {
    setImmediate(() => {
      sendPushToUserIds(pushRecipients, input.title, input.body || input.title, pushData).catch(
        (err) => console.warn('[dispatchNotification] push failed:', err?.message || err)
      );
    });
  }

  if (emailRecipients.length > 0) {
    setImmediate(() => {
      // SMTP hook placeholder
    });
  }

  const sentRecipientIds = new Set([
    ...inAppRecipients,
    ...pushRecipients,
    ...emailRecipients,
  ]);
  return { sent: sentRecipientIds.size };
};
