import { query } from '../config/database';
import { advanceCycleStartToFuture } from './cycleStartRecurrence';
import { logTaskActivity } from './taskActivityLogger';
import { resolveInitialAssigneeStatus } from './userTaskLifecycle';

const MONTH_ABBREVS = new Set([
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]);

/** Strip trailing month suffix so template title stays a stable base (e.g. "abcd apr" / legacy "abcd - Apr" → "abcd"). */
export const extractBaseTitle = (title: string): string => {
  const t = (title || '').trim();
  if (!t) return t;
  const dashMonth = t.match(/^(.*)\s+[-–—]\s+([a-z]{3})\s*$/i);
  if (dashMonth) {
    const maybeMon = dashMonth[2].toLowerCase();
    if (MONTH_ABBREVS.has(maybeMon)) {
      return dashMonth[1].trim() || t;
    }
  }
  const parts = t.split(/\s+/);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1].toLowerCase().replace(/\.$/, '');
    if (last.length === 3 && MONTH_ABBREVS.has(last)) {
      return parts.slice(0, -1).join(' ').trim() || t;
    }
  }
  return t;
};

const MONTHS_SHORT = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

/** Title for one cycle: "{base} {mon}" using UTC month of cycle start (e.g. abcd apr). */
export const formatRecurringTitle = (title: string, cycleStartDate: Date): string => {
  const base = extractBaseTitle(title);
  const mon = MONTHS_SHORT[cycleStartDate.getUTCMonth()] || 'jan';
  return `${base} ${mon}`;
};

export const parsePgIntervalToMs = (value: unknown): number => {
  if (value == null) return 0;
  if (typeof value === 'object') {
    const raw = value as Record<string, any>;
    const days = Number(raw.days ?? raw.day ?? 0);
    const hours = Number(raw.hours ?? raw.hour ?? 0);
    const minutes = Number(raw.minutes ?? raw.minute ?? 0);
    const seconds = Number(raw.seconds ?? raw.second ?? 0);
    const milliseconds = Number(raw.milliseconds ?? raw.millisecond ?? 0);
    if ([days, hours, minutes, seconds, milliseconds].some((n) => !Number.isNaN(n))) {
      return (
        (Number.isNaN(days) ? 0 : days) * 24 * 60 * 60 * 1000 +
        (Number.isNaN(hours) ? 0 : hours) * 60 * 60 * 1000 +
        (Number.isNaN(minutes) ? 0 : minutes) * 60 * 1000 +
        (Number.isNaN(seconds) ? 0 : seconds) * 1000 +
        (Number.isNaN(milliseconds) ? 0 : milliseconds)
      );
    }
  }
  const asString = String(value);
  const dayMatch = asString.match(/(-?\d+)\s+day/);
  const hourMatch = asString.match(/(-?\d+):(\d+):(\d+)/);
  let ms = 0;
  if (dayMatch) ms += Number(dayMatch[1]) * 24 * 60 * 60 * 1000;
  if (hourMatch) {
    ms += Number(hourMatch[1]) * 60 * 60 * 1000;
    ms += Number(hourMatch[2]) * 60 * 1000;
    ms += Number(hourMatch[3]) * 1000;
  }
  if (!dayMatch && !hourMatch && asString.includes('sec')) {
    const secMatch = asString.match(/(-?\d+(?:\.\d+)?)\s*sec/);
    if (secMatch) ms += Number(secMatch[1]) * 1000;
  }
  return ms;
};

const normalizeTemplateFrequency = (
  recurrenceType: string | null,
  specificWeekday: number | null
): any => {
  const normalized = String(recurrenceType || '').toLowerCase().trim();
  if (normalized === 'daily') return 'weekly';
  if (normalized === 'weekly') {
    // Legacy weekly templates may not carry specific_weekday.
    // Falling back to weekly prevents endless regeneration every scheduler run.
    return specificWeekday === null || specificWeekday === undefined ? 'weekly' : 'specific_weekday';
  }
  if (normalized === 'monthly') return 'monthly';
  if (normalized === 'quarterly') return 'quarterly';
  if (normalized === 'annually' || normalized === 'yearly') return 'yearly';
  return 'monthly';
};

/**
 * Generate next occurrence for recurring tasks
 */
export const generateNextRecurrence = async (): Promise<void> => {
  const tableCheck = await query(
    `SELECT to_regclass('public.task_recurrence_templates') AS table_name`,
    []
  );
  if (!tableCheck.rows[0]?.table_name) {
    return;
  }
  const result = await query(
    `SELECT *
     FROM task_recurrence_templates
     WHERE status = 'active'
       AND next_recurrence_date IS NOT NULL
       AND next_recurrence_date <= NOW()
     ORDER BY next_recurrence_date ASC`,
    []
  );

  for (const template of result.rows) {
    const recurrenceDate = new Date(template.next_recurrence_date);
    const targetOffsetMs = parsePgIntervalToMs(template.base_target_offset);
    const dueOffsetMs = parsePgIntervalToMs(template.base_due_offset);

    const startDate = recurrenceDate;
    const targetDate = targetOffsetMs > 0 ? new Date(startDate.getTime() + targetOffsetMs) : null;
    const dueDate = new Date(startDate.getTime() + dueOffsetMs);
    const now = new Date();
    const initialStatus = 'pending';
    // Recurring instances must start in todo for all assignees/owner.
    // Progress to in_progress should happen only through user action.
    const assigneeStatus = resolveInitialAssigneeStatus({ startDate });

    const assigneesResult = await query(
      `SELECT user_id, role FROM task_template_assignees WHERE template_id = $1`,
      [template.id]
    );
    const assignees = assigneesResult.rows.map((row) => ({
      userId: row.user_id as string,
      role: (row.role as string | null) || 'member',
    }));
    const assigneeUserIds = assignees.map((a) => a.userId);
    const creatorId =
      assignees.find((a) => a.role === 'creator')?.userId || template.creator_id;

    const normalizedFrequency = normalizeTemplateFrequency(
      template.recurrence_type,
      template.specific_weekday
    );

    const existingInstanceResult = await query(
      `SELECT id
       FROM tasks
       WHERE recurrence_template_id = $1
         AND start_date = $2
       LIMIT 1`,
      [template.id, startDate]
    );

    const lastCountResult = await query(
      `SELECT COALESCE(MAX(recurrence_instance_no), 0) AS max_no
       FROM tasks
       WHERE recurrence_template_id = $1`,
      [template.id]
    );
    const nextInstanceNo = Number(lastCountResult.rows[0]?.max_no || 0) + 1;

    let newTask: any = null;
    if (existingInstanceResult.rows.length === 0) {
      const newTaskResult = await query(
        `INSERT INTO tasks (
          id, title, description, task_type, creator_id, created_by, organization_id,
          start_date, target_date, due_date, frequency, specific_weekday, recurrence_type, recurrence_interval,
          category, status, recurrence_template_id, parent_task_id, recurrence_instance_no, reporting_member_id
        )
        VALUES (
          gen_random_uuid(), $1, $2, 'recurring_instance', $3, $3, $4,
          $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $14, $15, $16
        )
        RETURNING *`,
        [
          formatRecurringTitle(template.title, startDate),
          template.description,
          creatorId,
          template.organization_id,
          startDate,
          targetDate,
          dueDate,
          normalizedFrequency,
          template.specific_weekday,
          template.recurrence_type,
          template.recurrence_interval || 1,
          template.category || 'general',
          initialStatus,
          template.id,
          nextInstanceNo,
          template.reporting_member_id || null,
        ]
      );

      newTask = newTaskResult.rows[0];

      for (const a of assignees) {
        await query(
          `INSERT INTO task_assignees (task_id, user_id, status, role, completed_at, verified_at)
           VALUES ($1, $2, $3, $4, NULL, NULL)
           ON CONFLICT (task_id, user_id) DO UPDATE
           SET status = EXCLUDED.status`,
          [newTask.id, a.userId, assigneeStatus, a.role]
        );
      }

      // Create task conversation group (same model used by manual task creation).
      const convTypeCheck = await query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_name = 'conversations' AND column_name = 'type'`,
        []
      );
      const hasConversationType = convTypeCheck.rows.length > 0;
      const conversationResult = hasConversationType
        ? await query(
            `INSERT INTO conversations (id, type, name, is_group, is_task_group, task_id, created_by)
             VALUES (gen_random_uuid(), 'group', $1, TRUE, TRUE, $2, $3)
             RETURNING id`,
            [`Task: ${newTask.title}`, newTask.id, creatorId]
          )
        : await query(
            `INSERT INTO conversations (name, is_group, is_task_group, task_id, created_by)
             VALUES ($1, TRUE, TRUE, $2, $3)
             RETURNING id`,
            [`Task: ${newTask.title}`, newTask.id, creatorId]
          );

      const conversationId = conversationResult.rows[0]?.id;
      if (conversationId) {
        await query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           VALUES ($1, $2, 'admin')
           ON CONFLICT (conversation_id, user_id) DO NOTHING`,
          [conversationId, creatorId]
        );
        for (const assigneeId of assigneeUserIds) {
          if (String(assigneeId) === String(creatorId)) continue;
          await query(
            `INSERT INTO conversation_members (conversation_id, user_id, role)
             VALUES ($1, $2, 'member')
             ON CONFLICT (conversation_id, user_id) DO NOTHING`,
            [conversationId, assigneeId]
          );
        }

        const messageColumnCheck = await query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'messages' AND column_name = 'sender_organization_id'`,
          []
        );
        const hasSenderOrgId = messageColumnCheck.rows.some(
          (r: any) => r.column_name === 'sender_organization_id'
        );
        const messageColumns = ['conversation_id', 'sender_id', 'content', 'message_type'];
        const messageValues: any[] = [
          conversationId,
          creatorId,
          'Task group auto-created for recurring cycle',
          'text',
        ];
        if (hasSenderOrgId && template.organization_id) {
          messageColumns.push('sender_organization_id');
          messageValues.push(template.organization_id);
        }
        const placeholders = messageValues.map((_, i) => `$${i + 1}`).join(', ');
        await query(
          `INSERT INTO messages (${messageColumns.join(', ')})
           VALUES (${placeholders})`,
          messageValues
        );
      }
    }

    const nextRecurrenceDate = advanceCycleStartToFuture(
      template.recurrence_type,
      template.recurrence_interval,
      template.specific_weekday,
      recurrenceDate,
      now
    );
    await query(
      `UPDATE task_recurrence_templates
       SET last_generated_at = NOW(),
           next_recurrence_date = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [nextRecurrenceDate, template.id]
    );

    if (creatorId && newTask?.id) {
      await logTaskActivity(null, {
        taskId: newTask.id,
        userId: creatorId,
        activityType: 'recurrence_started',
        message: 'New recurrence cycle created',
      });
    }
  }
};

