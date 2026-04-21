import cron from 'node-cron';
import {
  escalateUnacceptedTasks,
  escalateOverdueTasks,
  escalateMissedRecurrence,
} from '../services/escalationService';
import { generateNextRecurrence } from '../services/recurringTaskService';
import { query } from '../config/database';
import { processTaskBulkQueue } from './taskBulkWorker';
import { processEntityMasterBulkQueue } from './entityMasterBulkWorker';

/**
 * Update task statuses (overdue, due soon)
 */
export const updateTaskStatuses = async (io?: any): Promise<void> => {
  // Move TODO/PENDING tasks to ACTIVE when start_date has arrived.
  const activatedTasks = await query(
    `UPDATE tasks
     SET status = 'active', updated_at = NOW()
     WHERE start_date IS NOT NULL
       AND start_date <= NOW()
       AND status IN ('todo', 'pending')
     RETURNING id`,
    []
  );
  for (const row of activatedTasks.rows || []) {
    io?.to(`task_${row.id}`).emit('task:status_changed', {
      taskId: row.id,
      fromStatus: 'todo',
      toStatus: 'active',
      computedAt: new Date().toISOString(),
    });
  }

  // Update assignee state to inprogress once ACTIVE.
  await query(
    `UPDATE task_assignees ta
     SET status = 'inprogress'
     FROM tasks t
     WHERE ta.task_id = t.id
       AND t.status = 'active'
       AND (ta.status IS NULL OR ta.status = 'todo')`,
    []
  );

  // Recurring instance lifecycle around each occurrence:
  // - 3 days before due_date: ensure task is in "pending" (todo) state
  // - On due_date: move task to "in_progress" automatically
  await query(
    `UPDATE tasks
     SET status = 'pending', updated_at = NOW()
     WHERE task_type IN ('recurring', 'recurring_instance')
       AND due_date IS NOT NULL
       AND status NOT IN ('completed', 'rejected')
       AND (due_date::date - INTERVAL '3 days') = CURRENT_DATE`,
    []
  );

  await query(
    `UPDATE tasks
     SET status = 'in_progress', updated_at = NOW()
     WHERE task_type IN ('recurring', 'recurring_instance')
       AND due_date IS NOT NULL
       AND status NOT IN ('completed', 'rejected', 'in_progress')
       AND due_date::date = CURRENT_DATE`,
    []
  );
};

/**
 * Setup scheduled jobs
 */
export const setupTaskJobs = (io?: any): void => {
  // Run every 15 minutes for lifecycle transitions.
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

  // Run every 15 minutes: generate new recurring instances from templates.
  cron.schedule('*/15 * * * *', async () => {
    console.log('Running recurring task generation job...');
    try {
      await generateNextRecurrence();
    } catch (error) {
      console.error('Error in recurring task generation job:', error);
    }
  });

  // Run every 2 minutes: Process bulk upload queues (tasks row-level, entity master file-level)
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

