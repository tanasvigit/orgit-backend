import { query } from '../config/database';
import { createMessage } from './messageService';
import { getTaskAssignments } from './taskService';
import { getAutoEscalationConfig } from './platformSettingsService';

/**
 * Check and escalate tasks that are not accepted
 */
export const escalateUnacceptedTasks = async (): Promise<void> => {
  const config = await getAutoEscalationConfig();
  
  if (!config.enabled) {
    return;
  }

  // Get tasks with pending assignments that are past their start date + configured hours
  const result = await query(
    `SELECT DISTINCT t.*, ta.assigned_to_user_id, ta.assigned_by_user_id
     FROM tasks t
     INNER JOIN task_assignments ta ON t.id = ta.task_id
     WHERE ta.status = 'pending'
     AND t.start_date IS NOT NULL
     AND t.start_date <= CURRENT_TIMESTAMP - INTERVAL '1 hour' * $1
     AND t.escalation_status = 'none'`,
    [config.unacceptedHours]
  );

  for (const row of result.rows) {
    await escalateTask(row.id, `Task not accepted within ${config.unacceptedHours} hours`);
  }
};

/**
 * Check and escalate overdue tasks
 */
export const escalateOverdueTasks = async (): Promise<void> => {
  const config = await getAutoEscalationConfig();
  
  if (!config.enabled) {
    return;
  }

  // Get tasks that are overdue by configured days
  const result = await query(
    `SELECT DISTINCT t.*
     FROM tasks t
     INNER JOIN task_assignments ta ON t.id = ta.task_id
     WHERE ta.status IN ('accepted', 'in_progress')
     AND t.due_date IS NOT NULL
     AND t.due_date < CURRENT_DATE - INTERVAL '1 day' * $1
     AND t.status != 'completed'
     AND t.escalation_status = 'none'`,
    [config.overdueDays]
  );

  for (const row of result.rows) {
    await escalateTask(row.id, `Task is overdue by more than ${config.overdueDays} days`);
  }
};

/**
 * Escalate a task
 */
export const escalateTask = async (
  taskId: string,
  reason: string
): Promise<void> => {
  // Update task escalation status
  await query(
    `UPDATE tasks 
     SET escalation_status = 'escalated', updated_at = NOW()
     WHERE id = $1`,
    [taskId]
  );

  // Get task group
  const groupResult = await query(
    `SELECT id FROM groups WHERE task_id = $1 LIMIT 1`,
    [taskId]
  );

  if (groupResult.rows.length > 0) {
    const groupId = groupResult.rows[0].id;
    const taskResult = await query('SELECT title, creator_id, organization_id FROM tasks WHERE id = $1', [taskId]);
    const task = taskResult.rows[0];

    // Send escalation message to task group
    await createMessage(
      task.creator_id, // System message from creator
      null,
      groupId,
      'text',
      `⚠️ Task Escalation: ${task.title}\nReason: ${reason}`,
      null,
      null,
      null,
      null,
      'shared_to_group',
      task.organization_id,
      null,
      null,
      [],
      []
    );
  }

  // Create notifications for all assignees
  const assignments = await getTaskAssignments(taskId);
  for (const assignment of assignments) {
    await query(
      `INSERT INTO notifications (
        id, user_id, title, description, type, related_entity_type, related_entity_id
      )
      VALUES (
        gen_random_uuid(), $1, 'Task Escalated', $2, 'task_escalated', 'task', $3
      )`,
      [assignment.assignedToUserId, reason, taskId]
    );
  }
};

/**
 * Check and escalate missed recurring tasks
 */
export const escalateMissedRecurrence = async (): Promise<void> => {
  const config = await getAutoEscalationConfig();
  
  if (!config.enabled || !config.missedRecurrenceEnabled) {
    return;
  }

  const result = await query(
    `SELECT * FROM tasks
     WHERE task_type = 'recurring'
     AND next_recurrence_date IS NOT NULL
     AND next_recurrence_date < CURRENT_DATE
     AND status != 'completed'
     AND escalation_status = 'none'`,
    []
  );

  for (const row of result.rows) {
    await escalateTask(row.id, 'Recurring task missed its scheduled date');
  }
};

