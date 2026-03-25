import { query } from '../config/database';
import { createTaskGroup } from './groupService';
import { calculateNextRecurrenceDate } from './taskService';
import { logTaskActivity } from './taskActivityLogger';

/**
 * Generate next occurrence for recurring tasks
 */
export const generateNextRecurrence = async (): Promise<void> => {
  // Get recurring tasks that are completed and have a next recurrence date
  const result = await query(
    `SELECT * FROM tasks
     WHERE task_type = 'recurring'
     AND status = 'completed'
     AND next_recurrence_date IS NOT NULL
     AND next_recurrence_date <= CURRENT_DATE`,
    []
  );

  for (const originalTask of result.rows) {
    // Get task assignees (participants for next cycle)
    const assigneesResult = await query(
      `SELECT user_id, role FROM task_assignees WHERE task_id = $1`,
      [originalTask.id]
    );
    const assignees = assigneesResult.rows.map((row) => ({
      userId: row.user_id as string,
      role: (row.role as string | null) || 'member',
    }));
    const assigneeUserIds = assignees.map((a) => a.userId);

    // Calculate dates for new task
    const baseDueDate = originalTask.due_date ? new Date(originalTask.due_date) : null;
    const nextRecurrenceDate = calculateNextRecurrenceDate(
      originalTask.frequency,
      originalTask.specific_weekday,
      baseDueDate
    );

    // Calculate new due date (same offset from recurrence date)
    let newDueDate: Date | null = null;
    if (originalTask.due_date && originalTask.next_recurrence_date) {
      const originalDue = new Date(originalTask.due_date);
      const originalRecurrence = new Date(originalTask.next_recurrence_date);
      const daysOffset = Math.floor(
        (originalDue.getTime() - originalRecurrence.getTime()) / (1000 * 60 * 60 * 24)
      );
      newDueDate = new Date(nextRecurrenceDate);
      newDueDate.setDate(newDueDate.getDate() + daysOffset);
    }

    // Create new task occurrence
    const newTaskResult = await query(
      `INSERT INTO tasks (
        id, title, description, task_type, creator_id, organization_id,
        start_date, target_date, due_date, frequency, specific_weekday,
        next_recurrence_date, category, status
      )
      VALUES (
      gen_random_uuid(), $1, $2, 'recurring', $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending'
      )
      RETURNING *`,
      [
        originalTask.title,
        originalTask.description,
        originalTask.creator_id,
        originalTask.organization_id,
      // For each new recurrence, the "start_date" of the cycle should be the
      // date on which this recurrence becomes active. That is the original
      // task's next_recurrence_date (or the freshly calculated nextRecurrenceDate
      // if the column is missing).
      originalTask.next_recurrence_date || nextRecurrenceDate,
        originalTask.target_date,
        newDueDate,
        originalTask.frequency,
        originalTask.specific_weekday,
        calculateNextRecurrenceDate(
          originalTask.frequency,
          originalTask.specific_weekday,
          newDueDate
        ),
        originalTask.category,
      ]
    );

    const newTask = newTaskResult.rows[0];

    // Create task assignments for history (if table is used elsewhere)
    for (const userId of assigneeUserIds) {
      await query(
        `INSERT INTO task_assignments (
          id, task_id, assigned_to_user_id, assigned_by_user_id, status
        )
        VALUES (gen_random_uuid(), $1, $2, $3, 'pending')`,
        [newTask.id, userId, originalTask.creator_id]
      );
    }

    // Initialize task_assignees for the new cycle (all participants start at todo)
    for (const a of assignees) {
      await query(
        `INSERT INTO task_assignees (task_id, user_id, status, role)
         VALUES ($1, $2, 'todo', $3)
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [newTask.id, a.userId, a.role]
      );
    }

    // Create task group
    await createTaskGroup(newTask.id, originalTask.creator_id, assigneeUserIds, originalTask.organization_id);

    // Update original task's next recurrence date
    await query(
      `UPDATE tasks 
       SET next_recurrence_date = $1, updated_at = NOW()
       WHERE id = $2`,
      [
        calculateNextRecurrenceDate(
          originalTask.frequency,
          originalTask.specific_weekday,
          newDueDate
        ),
        originalTask.id,
      ]
    );

    // Log recurrence started activity for creator
    if (originalTask.creator_id) {
      await logTaskActivity(null, {
        taskId: newTask.id,
        userId: originalTask.creator_id,
        activityType: 'recurrence_started',
        message: 'New recurrence cycle created',
      });
    }
  }
};

