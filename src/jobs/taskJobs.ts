import cron from 'node-cron';
import {
  escalateUnacceptedTasks,
  escalateOverdueTasks,
  escalateMissedRecurrence,
} from '../services/escalationService';
import { generateNextRecurrence } from '../services/recurringTaskService';
import { calculateNextRecurrenceDate } from '../services/taskService';
import { query } from '../config/database';
import { processTaskBulkQueue } from './taskBulkWorker';
import { processEntityMasterBulkQueue } from './entityMasterBulkWorker';

/**
 * Update task statuses (overdue, due soon)
 */
export const updateTaskStatuses = async (): Promise<void> => {
  // Mark tasks as overdue at task level
  await query(
    `UPDATE tasks 
     SET status = 'overdue', updated_at = NOW()
     WHERE due_date IS NOT NULL
     AND due_date < CURRENT_DATE
     AND status NOT IN ('completed', 'rejected', 'overdue')`,
    []
  );

  // Per-user overdue: mark member status as overdue when task due_date has passed
  await query(
    `UPDATE task_assignees ta
     SET status = 'overdue'
     FROM tasks t
     WHERE ta.task_id = t.id
       AND t.due_date IS NOT NULL
       AND t.due_date < CURRENT_DATE
       AND (ta.status IS NULL OR ta.status NOT IN ('completed','overdue'))`,
    []
  );

  // Per-user "Due Soon" based on due_date and a fixed 3-day window
  await query(
    `UPDATE task_assignees ta
     SET status = 'duesoon'
     FROM tasks t
     WHERE ta.task_id = t.id
       AND t.due_date IS NOT NULL
       AND t.due_date::date >= CURRENT_DATE
       AND t.due_date::date <= CURRENT_DATE + INTERVAL '3 days'
       AND (ta.status IS NULL OR ta.status IN ('todo','inprogress'))`,
    []
  );

  // Auto-rollover for recurring tasks:
  // If a recurring task is missed, move it to the next recurrence automatically
  // (per business rule: do not keep old missed occurrences visible).
  const recurringToRollover = await query(
    `SELECT id, due_date, frequency, specific_weekday
     FROM tasks
     WHERE task_type = 'recurring'
       AND due_date IS NOT NULL
       AND due_date < CURRENT_DATE
       AND status != 'completed'`,
    []
  );

  // Recurring task lifecycle around each occurrence:
  // - 3 days before due_date: ensure task is in "pending" (todo) state
  // - On due_date: move task to "in_progress" automatically
  await query(
    `UPDATE tasks
     SET status = 'pending', updated_at = NOW()
     WHERE task_type = 'recurring'
       AND due_date IS NOT NULL
       AND status NOT IN ('completed', 'rejected')
       AND (due_date::date - INTERVAL '3 days') = CURRENT_DATE`,
    []
  );

  await query(
    `UPDATE tasks
     SET status = 'in_progress', updated_at = NOW()
     WHERE task_type = 'recurring'
       AND due_date IS NOT NULL
       AND status NOT IN ('completed', 'rejected', 'in_progress')
       AND due_date::date = CURRENT_DATE`,
    []
  );

  for (const row of recurringToRollover.rows) {
    try {
      const currentDue = new Date(row.due_date);
      const frequency = row.frequency as any;
      const specificWeekday = row.specific_weekday as number | null;

      let nextDue = currentDue;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      // advance until nextDue is today or later
      let guard = 0;
      while (nextDue < today && guard < 400) {
        nextDue = calculateNextRecurrenceDate(frequency, specificWeekday, nextDue);
        guard++;
      }

      const nextRecurrence = calculateNextRecurrenceDate(frequency, specificWeekday, nextDue);

      await query(
        `UPDATE tasks
         SET due_date = $1,
             next_recurrence_date = $2,
             status = 'pending',
             updated_at = NOW()
         WHERE id = $3`,
        [nextDue, nextRecurrence, row.id]
      );

      // Reset per-member progress for the new cycle
      await query(
        `UPDATE task_assignees
         SET accepted_at = NULL,
             completed_at = NULL,
             verified_at = NULL,
             status = 'todo'
         WHERE task_id = $1`,
        [row.id]
      );
    } catch (e) {
      console.error('Recurring rollover failed for task:', row?.id, e);
    }
  }
};

/**
 * Setup scheduled jobs
 */
export const setupTaskJobs = (): void => {
  // Run every hour: Check for escalations and update task statuses
  cron.schedule('0 * * * *', async () => {
    console.log('Running task status update job...');
    try {
      await updateTaskStatuses();
      await escalateUnacceptedTasks();
      await escalateOverdueTasks();
      await escalateMissedRecurrence();
    } catch (error) {
      console.error('Error in task status update job:', error);
    }
  });

  // Run daily at midnight: Generate next recurrence for recurring tasks
  cron.schedule('0 0 * * *', async () => {
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

