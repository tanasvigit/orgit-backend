import { query } from '../config/database';

export const TASK_CARD_DISPLAY_FIELD_KEYS = [
  'title',
  'statusIcon',
  'tagOrClient',
  'dueDate',
  'frequency',
  'taskUnit',
  'assigneeProfiles',
  'unreadBadge',
  'overdueBadge',
] as const;

export type TaskCardDisplayFieldKey = (typeof TASK_CARD_DISPLAY_FIELD_KEYS)[number];

export type TaskCardDisplayConfig = Record<TaskCardDisplayFieldKey, boolean>;

export const DEFAULT_TASK_CARD_DISPLAY: TaskCardDisplayConfig = {
  title: true,
  statusIcon: true,
  tagOrClient: true,
  dueDate: true,
  frequency: true,
  taskUnit: true,
  assigneeProfiles: true,
  unreadBadge: true,
  overdueBadge: true,
};

export const DEFAULT_TASK_PUSH_NOTIFICATION_TIME = '09:00';
export const DEFAULT_TASK_PUSH_TIMEZONE = 'Asia/Kolkata';

export type TaskCreationUserConfigPayload = {
  dueDaysFromStart: number;
  targetDaysBeforeDue: number;
  autoEscalateTrigger: 'target_date' | 'due_date';
  taskUnitPreference: 'org_unit';
  taskCardDisplay: TaskCardDisplayConfig;
  /** Local HH:mm when daily task digest push is sent (e.g. 09:00). */
  taskPushNotificationTime: string;
  taskPushNotificationsEnabled: boolean;
  /** IANA timezone for scheduling digest pushes. */
  timezone: string;
  /** Server-managed ISO timestamp of last digest push; preserved across user saves. */
  lastTaskPushDigestAt?: string | null;
};

export const DEFAULT_TASK_CREATION_USER_CONFIG: TaskCreationUserConfigPayload = {
  dueDaysFromStart: 10,
  targetDaysBeforeDue: 3,
  autoEscalateTrigger: 'target_date',
  taskUnitPreference: 'org_unit',
  taskCardDisplay: { ...DEFAULT_TASK_CARD_DISPLAY },
  taskPushNotificationTime: DEFAULT_TASK_PUSH_NOTIFICATION_TIME,
  taskPushNotificationsEnabled: true,
  timezone: DEFAULT_TASK_PUSH_TIMEZONE,
  lastTaskPushDigestAt: null,
};

function normalizeTaskPushTime(raw: unknown): string {
  const s = String(raw ?? '').trim();
  const match = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return DEFAULT_TASK_PUSH_NOTIFICATION_TIME;
  const hour = Math.min(23, Math.max(0, Number.parseInt(match[1], 10)));
  const minute = Math.min(59, Math.max(0, Number.parseInt(match[2], 10)));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeTimezone(raw: unknown): string {
  const tz = String(raw ?? '').trim();
  if (!tz) return DEFAULT_TASK_PUSH_TIMEZONE;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TASK_PUSH_TIMEZONE;
  }
}

export function mergeTaskCardDisplayConfig(stored: unknown): TaskCardDisplayConfig {
  const base = { ...DEFAULT_TASK_CARD_DISPLAY };
  if (!isPlainObject(stored)) return base;
  for (const key of TASK_CARD_DISPLAY_FIELD_KEYS) {
    if (typeof stored[key] === 'boolean') {
      base[key] = stored[key];
    }
  }
  return base;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function mergeTaskCreationUserConfig(
  stored: unknown | null | undefined
): TaskCreationUserConfigPayload {
  const base = { ...DEFAULT_TASK_CREATION_USER_CONFIG };
  if (!isPlainObject(stored)) return base;

  const dueRaw = stored.dueDaysFromStart;
  if (typeof dueRaw === 'number' && Number.isFinite(dueRaw)) {
    base.dueDaysFromStart = Math.max(1, Math.min(365, Math.round(dueRaw)));
  }

  const targetRaw = stored.targetDaysBeforeDue;
  if (typeof targetRaw === 'number' && Number.isFinite(targetRaw)) {
    base.targetDaysBeforeDue = Math.max(0, Math.min(365, Math.round(targetRaw)));
  }

  const trig = stored.autoEscalateTrigger;
  if (trig === 'target_date' || trig === 'due_date') {
    base.autoEscalateTrigger = trig;
  }

  const unitPref = stored.taskUnitPreference;
  if (unitPref === 'org_unit' || unitPref === 'org_node') {
    base.taskUnitPreference = 'org_unit';
  }

  if (base.targetDaysBeforeDue > base.dueDaysFromStart) {
    base.targetDaysBeforeDue = Math.min(base.targetDaysBeforeDue, base.dueDaysFromStart);
  }

  base.taskCardDisplay = mergeTaskCardDisplayConfig(stored.taskCardDisplay);

  base.taskPushNotificationTime = normalizeTaskPushTime(stored.taskPushNotificationTime);
  if (typeof stored.taskPushNotificationsEnabled === 'boolean') {
    base.taskPushNotificationsEnabled = stored.taskPushNotificationsEnabled;
  }
  base.timezone = normalizeTimezone(stored.timezone);
  if (typeof stored.lastTaskPushDigestAt === 'string' && stored.lastTaskPushDigestAt.trim()) {
    base.lastTaskPushDigestAt = stored.lastTaskPushDigestAt.trim();
  }

  return base;
}

/** Strip server-only fields before returning config to clients. */
export function toClientTaskCreationUserConfig(
  config: TaskCreationUserConfigPayload
): Omit<TaskCreationUserConfigPayload, 'lastTaskPushDigestAt'> {
  const { lastTaskPushDigestAt: _omit, ...client } = config;
  return client;
}

export function parseAndValidateTaskCreationUserConfigBody(body: unknown): TaskCreationUserConfigPayload {
  if (!isPlainObject(body)) {
    throw new Error('Invalid request body');
  }
  const dueDaysFromStart = Number(body.dueDaysFromStart);
  const targetDaysBeforeDue = Number(body.targetDaysBeforeDue);
  const autoEscalateTrigger = body.autoEscalateTrigger;
  const taskUnitPreference = body.taskUnitPreference;

  if (!Number.isFinite(dueDaysFromStart) || dueDaysFromStart < 1 || dueDaysFromStart > 365) {
    throw new Error('dueDaysFromStart must be between 1 and 365');
  }
  if (!Number.isFinite(targetDaysBeforeDue) || targetDaysBeforeDue < 0 || targetDaysBeforeDue > 365) {
    throw new Error('targetDaysBeforeDue must be between 0 and 365');
  }
  if (targetDaysBeforeDue > dueDaysFromStart) {
    throw new Error('targetDaysBeforeDue cannot be greater than dueDaysFromStart');
  }
  if (autoEscalateTrigger !== 'target_date' && autoEscalateTrigger !== 'due_date') {
    throw new Error('autoEscalateTrigger must be target_date or due_date');
  }
  if (
    taskUnitPreference !== undefined &&
    taskUnitPreference !== 'org_unit' &&
    taskUnitPreference !== 'org_node'
  ) {
    throw new Error('taskUnitPreference must be org_unit');
  }

  const taskPushNotificationTime = normalizeTaskPushTime(body.taskPushNotificationTime);
  const taskPushNotificationsEnabled =
    typeof body.taskPushNotificationsEnabled === 'boolean'
      ? body.taskPushNotificationsEnabled
      : DEFAULT_TASK_CREATION_USER_CONFIG.taskPushNotificationsEnabled;
  const timezone = normalizeTimezone(body.timezone);

  return {
    dueDaysFromStart: Math.round(dueDaysFromStart),
    targetDaysBeforeDue: Math.round(targetDaysBeforeDue),
    autoEscalateTrigger,
    taskUnitPreference:
      taskUnitPreference === 'org_unit' || taskUnitPreference === 'org_node'
        ? 'org_unit'
        : DEFAULT_TASK_CREATION_USER_CONFIG.taskUnitPreference,
    taskCardDisplay: mergeTaskCardDisplayConfig(
      isPlainObject(body) ? body.taskCardDisplay : undefined
    ),
    taskPushNotificationTime,
    taskPushNotificationsEnabled,
    timezone,
  };
}

export async function getTaskCreationUserConfigForUser(userId: string): Promise<TaskCreationUserConfigPayload> {
  const result = await query(
    `SELECT task_creation_user_config FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  if (result.rows.length === 0) {
    return { ...DEFAULT_TASK_CREATION_USER_CONFIG };
  }
  return mergeTaskCreationUserConfig(result.rows[0]?.task_creation_user_config);
}

export async function updateTaskCreationUserConfigForUser(
  userId: string,
  config: Omit<TaskCreationUserConfigPayload, 'lastTaskPushDigestAt'>
): Promise<Omit<TaskCreationUserConfigPayload, 'lastTaskPushDigestAt'>> {
  const existing = await getTaskCreationUserConfigForUser(userId);
  const payload: TaskCreationUserConfigPayload = {
    ...config,
    lastTaskPushDigestAt: existing.lastTaskPushDigestAt ?? null,
  };
  await query(
    `UPDATE users SET task_creation_user_config = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [JSON.stringify(payload), userId]
  );
  return toClientTaskCreationUserConfig(payload);
}
