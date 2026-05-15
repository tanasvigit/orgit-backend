import { query } from '../config/database';

export type TaskCreationUserConfigPayload = {
  dueDaysFromStart: number;
  targetDaysBeforeDue: number;
  autoEscalateTrigger: 'target_date' | 'due_date';
  taskUnitPreference: 'org_node';
};

export const DEFAULT_TASK_CREATION_USER_CONFIG: TaskCreationUserConfigPayload = {
  dueDaysFromStart: 10,
  targetDaysBeforeDue: 3,
  autoEscalateTrigger: 'target_date',
  taskUnitPreference: 'org_node',
};

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
  if (unitPref === 'org_node') {
    base.taskUnitPreference = unitPref;
  }

  if (base.targetDaysBeforeDue > base.dueDaysFromStart) {
    base.targetDaysBeforeDue = Math.min(base.targetDaysBeforeDue, base.dueDaysFromStart);
  }

  return base;
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
  if (taskUnitPreference !== undefined && taskUnitPreference !== 'org_node') {
    throw new Error('taskUnitPreference must be org_node');
  }

  return {
    dueDaysFromStart: Math.round(dueDaysFromStart),
    targetDaysBeforeDue: Math.round(targetDaysBeforeDue),
    autoEscalateTrigger,
    taskUnitPreference:
      typeof taskUnitPreference === 'string'
        ? (taskUnitPreference as TaskCreationUserConfigPayload['taskUnitPreference'])
        : DEFAULT_TASK_CREATION_USER_CONFIG.taskUnitPreference,
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
  config: TaskCreationUserConfigPayload
): Promise<TaskCreationUserConfigPayload> {
  await query(
    `UPDATE users SET task_creation_user_config = $1::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
    [JSON.stringify(config), userId]
  );
  return config;
}
