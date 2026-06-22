import { query } from '../config/database';
import { dispatchNotification } from './notification-bus.service';
import {
  DEFAULT_TASK_PUSH_NOTIFICATION_TIME,
  DEFAULT_TASK_PUSH_TIMEZONE,
  mergeTaskCreationUserConfig,
  type TaskCreationUserConfigPayload,
} from './taskCreationUserConfigService';

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dateKey: string;
};

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value || '0';
  const year = Number(pick('year'));
  const month = Number(pick('month'));
  const day = Number(pick('day'));
  let hour = Number(pick('hour'));
  const minute = Number(pick('minute'));
  if (hour === 24) hour = 0;
  return {
    year,
    month,
    day,
    hour,
    minute,
    dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

function getStartOfZonedDayUtc(timeZone: string, ref: Date = new Date()): Date {
  const { year, month, day } = getZonedParts(ref, timeZone);
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const offsetMs = getTimezoneOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offsetMs);
}

function getTimezoneOffsetMs(date: Date, timeZone: string): number {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const local = new Date(date.toLocaleString('en-US', { timeZone }));
  return local.getTime() - utc.getTime();
}

function digestAlreadySentToday(
  lastTaskPushDigestAt: string | null | undefined,
  timeZone: string,
  now: Date
): boolean {
  if (!lastTaskPushDigestAt) return false;
  const last = new Date(lastTaskPushDigestAt);
  if (Number.isNaN(last.getTime())) return false;
  const todayKey = getZonedParts(now, timeZone).dateKey;
  const lastKey = getZonedParts(last, timeZone).dateKey;
  return todayKey === lastKey;
}

async function countNewTasksForUser(
  userId: string,
  since: Date
): Promise<{ count: number; sampleTitle: string | null; sampleTaskId: string | null }> {
  const countResult = await query(
    `SELECT COUNT(DISTINCT t.id)::int AS count
     FROM tasks t
     INNER JOIN task_assignees ta ON ta.task_id = t.id AND ta.user_id = $1
     WHERE ta.verified_at IS NULL
       AND ta.completed_at IS NULL
       AND COALESCE(t.status, '') NOT IN ('completed', 'cancelled', 'rejected')
       AND (
         t.created_at >= $2
         OR ta.created_at >= $2
       )`,
    [userId, since]
  );
  const count = Number(countResult.rows[0]?.count || 0);
  if (count === 0) return { count: 0, sampleTitle: null, sampleTaskId: null };

  const sampleResult = await query(
    `SELECT t.id, t.title
     FROM tasks t
     INNER JOIN task_assignees ta ON ta.task_id = t.id AND ta.user_id = $1
     WHERE ta.verified_at IS NULL
       AND ta.completed_at IS NULL
       AND COALESCE(t.status, '') NOT IN ('completed', 'cancelled', 'rejected')
       AND (
         t.created_at >= $2
         OR ta.created_at >= $2
       )
     ORDER BY GREATEST(t.created_at, ta.created_at) DESC
     LIMIT 1`,
    [userId, since]
  );
  return {
    count,
    sampleTitle: sampleResult.rows[0]?.title ? String(sampleResult.rows[0].title) : null,
    sampleTaskId: sampleResult.rows[0]?.id ? String(sampleResult.rows[0].id) : null,
  };
}

async function persistLastDigestAt(userId: string, at: Date): Promise<void> {
  const existing = await query(`SELECT task_creation_user_config FROM users WHERE id = $1 LIMIT 1`, [userId]);
  const stored = existing.rows[0]?.task_creation_user_config;
  const merged = mergeTaskCreationUserConfig(stored);
  const payload: TaskCreationUserConfigPayload = {
    ...merged,
    lastTaskPushDigestAt: at.toISOString(),
  };
  await query(
    `UPDATE users SET task_creation_user_config = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [JSON.stringify(payload), userId]
  );
}

/**
 * At each user's configured local time, send a mobile push summarizing tasks created/assigned since midnight.
 * Auto-generated recurring tasks only create in-app notifications immediately; mobile push is sent here.
 */
export async function processTaskPushDigests(io?: any): Promise<void> {
  const usersResult = await query(
    `SELECT id, task_creation_user_config
     FROM users
     WHERE status IS DISTINCT FROM 'inactive'
       AND task_creation_user_config IS NOT NULL`,
    []
  );

  const now = new Date();

  for (const row of usersResult.rows || []) {
    const userId = String(row.id);
    const config = mergeTaskCreationUserConfig(row.task_creation_user_config);

    if (!config.taskPushNotificationsEnabled) continue;

    const timeZone = config.timezone || DEFAULT_TASK_PUSH_TIMEZONE;
    const zonedNow = getZonedParts(now, timeZone);
    const [wantHour, wantMinute] = config.taskPushNotificationTime.split(':').map((v) => Number(v));

    if (zonedNow.hour !== wantHour || zonedNow.minute !== wantMinute) continue;
    if (digestAlreadySentToday(config.lastTaskPushDigestAt, timeZone, now)) continue;

    const since = getStartOfZonedDayUtc(timeZone, now);
    const { count, sampleTitle, sampleTaskId } = await countNewTasksForUser(userId, since);
    if (count === 0) {
      await persistLastDigestAt(userId, now);
      continue;
    }

    const title = count === 1 ? 'New task for you' : `${count} new tasks for you`;
    const body =
      count === 1 && sampleTitle
        ? `${sampleTitle} was assigned. Open Tasks to view it.`
        : `${count} task${count === 1 ? '' : 's'} assigned since midnight. Open Tasks to review them.`;

    await dispatchNotification({
      type: 'TASK_ASSIGNED',
      recipientIds: [userId],
      title,
      body,
      refType: 'task',
      refId: sampleTaskId,
      channels: ['in_app', 'push'],
      io,
    });

    await persistLastDigestAt(userId, now);
  }
}
