import { query } from '../config/database';
import { PoolClient } from 'pg';

type ActivityClient = PoolClient | null | undefined;

export type TaskActivityType =
  | 'created'
  | 'accepted'
  | 'rejected'
  | 'status_changed'
  | 'completion_pending'
  | 'completion_verified'
  | 'task_completed'
  | 'task_reassigned'
  | 'task_started'
  | 'task_overridden'
  | 'recurrence_started';

export interface TaskActivityPayload {
  taskId: string;
  userId: string;
  activityType: TaskActivityType | string;
  oldValue?: string | null;
  newValue?: string | null;
  message?: string | null;
}

export const logTaskActivity = async (
  client: ActivityClient,
  payload: TaskActivityPayload
): Promise<void> => {
  const { taskId, userId, activityType, oldValue, newValue, message } = payload;

  const text = `
    INSERT INTO task_activities (task_id, user_id, activity_type, old_value, new_value, message)
    VALUES ($1, $2, $3, $4, $5, $6)
  `;
  const values = [taskId, userId, activityType, oldValue || null, newValue || null, message || null];

  if (client) {
    await client.query(text, values);
  } else {
    await query(text, values);
  }
};

