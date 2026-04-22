import { query } from '../config/database';
import { createTaskGroup } from './groupService';
import { calculateNextRecurrenceDate } from './taskService';
import { logTaskActivity } from './taskActivityLogger';

const normalizeTemplateFrequency = (recurrenceType: string | null): any => {
  const normalized = String(recurrenceType || '').toLowerCase().trim();
  if (normalized === 'daily') return 'weekly';
  if (normalized === 'weekly') return 'specific_weekday';
  if (normalized === 'monthly') return 'monthly';
  if (normalized === 'quarterly') return 'quarterly';
  if (normalized === 'annually' || normalized === 'yearly') return 'yearly';
  return 'monthly';
};

const formatRecurringTitle = (title: string, date: Date): string => {
  const month = date.toLocaleString('en-US', { month: 'short' });
  return `${title} - ${month}`;
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
    const offsetMs = (() => {
      if (!template.base_due_offset) return 0;
      // base_due_offset arrives from PG interval as string in many drivers (e.g. "5 days")
      const asString = String(template.base_due_offset);
      const dayMatch = asString.match(/(-?\d+)\s+day/);
      const hourMatch = asString.match(/(-?\d+):(\d+):(\d+)/);
      let ms = 0;
      if (dayMatch) ms += Number(dayMatch[1]) * 24 * 60 * 60 * 1000;
      if (hourMatch) {
        ms += Number(hourMatch[1]) * 60 * 60 * 1000;
        ms += Number(hourMatch[2]) * 60 * 1000;
        ms += Number(hourMatch[3]) * 1000;
      }
      return ms;
    })();

    const startDate = recurrenceDate;
    const dueDate = new Date(startDate.getTime() + offsetMs);
    const now = new Date();
    const initialStatus = startDate.getTime() > now.getTime() ? 'pending' : 'in_progress';

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

    const lastCountResult = await query(
      `SELECT COALESCE(MAX(recurrence_instance_no), 0) AS max_no
       FROM tasks
       WHERE recurrence_template_id = $1`,
      [template.id]
    );
    const nextInstanceNo = Number(lastCountResult.rows[0]?.max_no || 0) + 1;

    const newTaskResult = await query(
      `INSERT INTO tasks (
        id, title, description, task_type, creator_id, created_by, organization_id,
        start_date, due_date, frequency, specific_weekday, recurrence_type, recurrence_interval,
        category, status, recurrence_template_id, parent_task_id, recurrence_instance_no, reporting_member_id
      )
      VALUES (
        gen_random_uuid(), $1, $2, 'recurring_instance', $3, $3, $4,
        $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $13, $14, $15
      )
      RETURNING *`,
      [
        formatRecurringTitle(template.title, startDate),
        template.description,
        creatorId,
        template.organization_id,
        startDate,
        dueDate,
        normalizeTemplateFrequency(template.recurrence_type),
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

    const newTask = newTaskResult.rows[0];

    for (const a of assignees) {
      await query(
        `INSERT INTO task_assignees (task_id, user_id, status, role, accepted_at, completed_at, verified_at)
         VALUES ($1, $2, 'todo', $3, NULL, NULL, NULL)
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [newTask.id, a.userId, a.role]
      );
    }

    await createTaskGroup(newTask.id, creatorId, assigneeUserIds, template.organization_id);

    const nextRecurrenceDate = calculateNextRecurrenceDate(
      normalizeTemplateFrequency(template.recurrence_type),
      template.specific_weekday,
      recurrenceDate
    );
    await query(
      `UPDATE task_recurrence_templates
       SET last_generated_at = NOW(),
           next_recurrence_date = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [nextRecurrenceDate, template.id]
    );

    if (creatorId) {
      await logTaskActivity(null, {
        taskId: newTask.id,
        userId: creatorId,
        activityType: 'recurrence_started',
        message: 'New recurrence cycle created',
      });
    }
  }
};

