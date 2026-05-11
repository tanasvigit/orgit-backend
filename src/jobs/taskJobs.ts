import cron from 'node-cron';
import {
  escalateUnacceptedTasks,
  escalateOverdueTasks,
  escalateMissedRecurrence,
} from '../services/escalationService';
import { generateNextRecurrence } from '../services/recurringTaskService';
import { query } from '../config/database';
import { getReminderConfig } from '../services/platformSettingsService';
import { processTaskBulkQueue } from './taskBulkWorker';
import { processEntityMasterBulkQueue } from './entityMasterBulkWorker';

/**
 * Keep per-user assignee status aligned with task start/due dates.
 */
export const updateTaskStatuses = async (io?: any): Promise<void> => {
  const activatedAssignees = await query(
    `UPDATE task_assignees ta
     SET status = 'todo'
     FROM tasks t
     WHERE ta.task_id = t.id
       AND ta.verified_at IS NULL
       AND ta.status = 'scheduled'
       AND t.start_date IS NOT NULL
       AND t.start_date::date <= CURRENT_DATE
     RETURNING ta.task_id, ta.user_id`,
    []
  );

  for (const row of activatedAssignees.rows || []) {
    io?.to(`task_${row.task_id}`).emit('task:status_changed', {
      taskId: row.task_id,
      userId: row.user_id,
      fromStatus: 'scheduled',
      toStatus: 'todo',
      computedAt: new Date().toISOString(),
    });
  }

  await query(
    `UPDATE task_assignees
     SET status = 'todo'
     WHERE verified_at IS NULL
       AND completed_at IS NULL
       AND status IN ('accepted', 'active')`,
    []
  );

  const { dueSoonDays } = await getReminderConfig();
  await query(
    `UPDATE task_assignees ta
     SET status = 'duesoon'
     FROM tasks t
     WHERE ta.task_id = t.id
       AND ta.verified_at IS NULL
       AND t.due_date IS NOT NULL
       AND t.due_date::date >= CURRENT_DATE
       AND t.due_date::date <= CURRENT_DATE + INTERVAL '1 day' * $1
       AND (t.start_date IS NULL OR t.start_date::date <= CURRENT_DATE)
       AND ta.status IN ('todo', 'scheduled')`,
    [dueSoonDays]
  );

  const overdueAssignees = await query(
    `UPDATE task_assignees ta
     SET status = 'overdue'
     FROM tasks t
     WHERE ta.task_id = t.id
       AND ta.verified_at IS NULL
       AND t.due_date IS NOT NULL
       AND t.due_date::date < CURRENT_DATE
       AND (t.start_date IS NULL OR t.start_date::date <= CURRENT_DATE)
       AND ta.status IN ('todo', 'inprogress', 'scheduled')
     RETURNING ta.task_id, ta.user_id`,
    []
  );

  for (const row of overdueAssignees.rows || []) {
    io?.to(`task_${row.task_id}`).emit('task:status_changed', {
      taskId: row.task_id,
      userId: row.user_id,
      fromStatus: 'todo',
      toStatus: 'overdue',
      computedAt: new Date().toISOString(),
    });
  }

  await query(
    `UPDATE tasks
     SET status = 'pending', updated_at = NOW()
     WHERE task_type IN ('recurring', 'recurring_instance')
       AND due_date IS NOT NULL
       AND status NOT IN ('completed', 'rejected')
       AND (due_date::date - INTERVAL '3 days') = CURRENT_DATE`,
    []
  );

};

/**
 * Setup scheduled jobs
 */
export const setupTaskJobs = (io?: any): void => {
  cron.schedule('*/15 * * * *', async () => {
    console.log('Running task status update job...');
    try {
      await updateTaskStatuses(io);
      await escalateUnacceptedTasks();
      await escalateOverdueTasks();
      await escalateMissedRecurrence();
    } catch (error) {
      console.error('Error in task status update job:', error);
    }
  });

  cron.schedule('*/15 * * * *', async () => {
    console.log('Running recurring task generation job...');
    try {
      await generateNextRecurrence();
    } catch (error) {
      console.error('Error in recurring task generation job:', error);
    }
  });

  cron.schedule('*/2 * * * *', async () => {
    try {
      await processTaskBulkQueue();
      await processEntityMasterBulkQueue();
    } catch (error) {
      console.error('Error in bulk upload worker:', error);
    }
  });

  console.log('Task scheduled jobs initialized');
};
