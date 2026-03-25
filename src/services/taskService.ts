import { query } from '../config/database';
import { v4 as uuidv4 } from 'uuid';
import { Task, TaskAssignment, TaskType, TaskStatus, TaskCategory, TaskFrequency } from '../../../shared/src/types';
import { createTaskGroup } from './groupService';
import { createNotification } from './notificationService';

/**
 * Create a new task
 */
export const createTask = async (
  title: string,
  description: string | null,
  taskType: TaskType,
  creatorId: string,
  organizationId: string,
  startDate: Date | null,
  targetDate: Date | null,
  dueDate: Date | null,
  frequency: TaskFrequency | null,
  specificWeekday: number | null,
  category: TaskCategory | null,
  assignedUserIds: string[],
  complianceId?: string | null
): Promise<Task> => {
  // Calculate next recurrence date for recurring tasks
  let nextRecurrenceDate: Date | null = null;
  if (taskType === 'recurring' && frequency) {
    nextRecurrenceDate = calculateNextRecurrenceDate(frequency, specificWeekday, dueDate);
  }

  const result = await query(
    `INSERT INTO tasks (
      id, title, description, task_type, creator_id, organization_id,
      start_date, target_date, due_date, frequency, specific_weekday,
      next_recurrence_date, category, status, compliance_id
    )
    VALUES (
      gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13
    )
    RETURNING *`,
    [
      title,
      description,
      taskType,
      creatorId,
      organizationId,
      startDate,
      targetDate,
      dueDate,
      frequency,
      specificWeekday,
      nextRecurrenceDate,
      category || 'general',
      complianceId || null,
    ]
  );

  const task = result.rows[0];

  // Create task assignments
  if (assignedUserIds.length > 0) {
    for (const userId of assignedUserIds) {
      await query(
        `INSERT INTO task_assignments (
          id, task_id, assigned_to_user_id, assigned_by_user_id, status
        )
        VALUES (gen_random_uuid(), $1, $2, $3, 'pending')`,
        [task.id, userId, creatorId]
      );
    }

    // Create task group automatically
    await createTaskGroup(task.id, creatorId, assignedUserIds, organizationId);

    // Create notifications for assignees
    for (const userId of assignedUserIds) {
      await createNotification(
        userId,
        'New Task Assigned',
        `You have been assigned a new task: ${title}`,
        'task_assigned',
        'task',
        task.id
      );
    }
  }

  // Log task creation
  await query(
    `INSERT INTO task_status_logs (
      id, task_id, new_status, changed_by_user_id, change_reason
    )
    VALUES (gen_random_uuid(), $1, 'pending', $2, 'Task created')`,
    [task.id, creatorId]
  );

  return task as Task;
};

/**
 * Calculate next recurrence date
 */
export const calculateNextRecurrenceDate = (
  frequency: TaskFrequency,
  specificWeekday: number | null,
  baseDate: Date | null
): Date => {
  const now = new Date();
  const base = baseDate || now;
  const nextDate = new Date(base);

  const addMonthsClamped = (date: Date, monthsToAdd: number): Date => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();

    const target = new Date(year, month + monthsToAdd, 1);
    const daysInTargetMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    const clampedDay = Math.min(day, daysInTargetMonth);

    const next = new Date(target.getFullYear(), target.getMonth(), clampedDay);
    next.setHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
    return next;
  };

  switch (frequency) {
    case 'weekly':
      nextDate.setDate(nextDate.getDate() + 7);
      break;
    case 'monthly':
      return addMonthsClamped(nextDate, 1);
    case 'quarterly':
      return addMonthsClamped(nextDate, 3);
    case 'yearly':
      return addMonthsClamped(nextDate, 12);
    case 'specific_weekday':
      if (specificWeekday !== null) {
        const daysUntilNext = (specificWeekday - nextDate.getDay() + 7) % 7 || 7;
        nextDate.setDate(nextDate.getDate() + daysUntilNext);
      }
      break;
  }

  return nextDate;
};

/**
 * Get task by ID
 */
export const getTaskById = async (taskId: string, userId: string): Promise<Task | null> => {
  // Check if user has access to this task
  const accessResult = await query(
    `SELECT 1 FROM tasks t
     LEFT JOIN task_assignments ta ON t.id = ta.task_id
     WHERE t.id = $1 AND (t.creator_id = $2 OR ta.assigned_to_user_id = $2)
     LIMIT 1`,
    [taskId, userId]
  );

  if (accessResult.rows.length === 0) {
    return null;
  }

  const result = await query(
    `SELECT t.*, cm.id as compliance_id, cm.title as compliance_title, cm.scope as compliance_scope
     FROM tasks t
     LEFT JOIN compliance_master cm ON t.compliance_id = cm.id
     WHERE t.id = $1`,
    [taskId]
  );
  
  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  const task: any = {
    ...row,
    complianceId: row.compliance_id || undefined,
  };

  // Add compliance info if linked
  if (row.compliance_id) {
    task.compliances = [{
      id: row.compliance_id,
      title: row.compliance_title,
      scope: row.compliance_scope,
    }];
  }

  return task as Task;
};

/**
 * Get tasks for a user
 */
export const getUserTasks = async (
  userId: string,
  filters: {
    status?: TaskStatus;
    category?: TaskCategory;
    taskType?: TaskType;
    isSelfTask?: boolean;
  } = {}
): Promise<Task[]> => {
  let queryText = '';
  const params: any[] = [userId];
  let paramIndex = 1;

  if (filters.isSelfTask) {
    queryText = `
      SELECT DISTINCT t.*
      FROM tasks t
      WHERE t.creator_id = $1
    `;
  } else {
    queryText = `
      SELECT DISTINCT t.*
      FROM tasks t
      INNER JOIN task_assignments ta ON t.id = ta.task_id
      WHERE ta.assigned_to_user_id = $1
    `;
  }

  if (filters.status) {
    paramIndex++;
    queryText += ` AND t.status = $${paramIndex}`;
    params.push(filters.status);
  }

  if (filters.category) {
    paramIndex++;
    queryText += ` AND t.category = $${paramIndex}`;
    params.push(filters.category);
  }

  if (filters.taskType) {
    paramIndex++;
    queryText += ` AND t.task_type = $${paramIndex}`;
    params.push(filters.taskType);
  }

  queryText += ' ORDER BY t.created_at DESC';

  const result = await query(queryText, params);
  return result.rows as Task[];
};

/**
 * Accept a task assignment
 */
export const acceptTask = async (
  taskId: string,
  userId: string
): Promise<TaskAssignment> => {
  const assignmentResult = await query(
    `UPDATE task_assignments 
     SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
     WHERE task_id = $1 AND assigned_to_user_id = $2 AND status = 'pending'
     RETURNING *`,
    [taskId, userId]
  );

  if (assignmentResult.rows.length === 0) {
    throw new Error('Task assignment not found or already processed');
  }

  const assignment = assignmentResult.rows[0];

  // Update task status to in_progress if at least one assignment is accepted
  await query(
    `UPDATE tasks 
     SET status = 'in_progress', updated_at = NOW()
     WHERE id = $1 AND status = 'pending'`,
    [taskId]
  );

  // Log status change
  await query(
    `INSERT INTO task_status_logs (
      id, task_id, assignment_id, old_status, new_status, changed_by_user_id, change_reason
    )
    VALUES (gen_random_uuid(), $1, $2, 'pending', 'accepted', $3, 'Task accepted by assignee')`,
    [taskId, assignment.id, userId]
  );

  // Notify task creator
  const taskResult = await query('SELECT creator_id, title FROM tasks WHERE id = $1', [taskId]);
  if (taskResult.rows.length > 0) {
    const task = taskResult.rows[0];
    await createNotification(
      task.creator_id,
      'Task Accepted',
      `Task "${task.title}" has been accepted`,
      'task_accepted',
      'task',
      taskId
    );
  }

  return assignment as TaskAssignment;
};

/**
 * Reject a task assignment
 */
export const rejectTask = async (
  taskId: string,
  userId: string,
  rejectionReason: string
): Promise<TaskAssignment> => {
  if (!rejectionReason || rejectionReason.trim().length === 0) {
    throw new Error('Rejection reason is required');
  }

  const assignmentResult = await query(
    `UPDATE task_assignments 
     SET status = 'rejected', rejection_reason = $1, rejected_at = NOW(), updated_at = NOW()
     WHERE task_id = $2 AND assigned_to_user_id = $3 AND status = 'pending'
     RETURNING *`,
    [rejectionReason, taskId, userId]
  );

  if (assignmentResult.rows.length === 0) {
    throw new Error('Task assignment not found or already processed');
  }

  const assignment = assignmentResult.rows[0];

  // Log status change
  await query(
    `INSERT INTO task_status_logs (
      id, task_id, assignment_id, old_status, new_status, changed_by_user_id, change_reason
    )
    VALUES (gen_random_uuid(), $1, $2, 'pending', 'rejected', $3, $4)`,
    [taskId, assignment.id, userId, rejectionReason]
  );

  // Notify task creator
  const taskResult = await query('SELECT creator_id, title FROM tasks WHERE id = $1', [taskId]);
  if (taskResult.rows.length > 0) {
    const task = taskResult.rows[0];
    await createNotification(
      task.creator_id,
      'Task Rejected',
      `Task "${task.title}" has been rejected. Reason: ${rejectionReason}`,
      'task_rejected',
      'task',
      taskId
    );
  }

  return assignment as TaskAssignment;
};

/**
 * Complete a task
 */
export const completeTask = async (
  taskId: string,
  userId: string
): Promise<TaskAssignment> => {
  const assignmentResult = await query(
    `UPDATE task_assignments 
     SET status = 'completed', completed_at = NOW(), updated_at = NOW()
     WHERE task_id = $1 AND assigned_to_user_id = $2 AND status IN ('accepted', 'in_progress')
     RETURNING *`,
    [taskId, userId]
  );

  if (assignmentResult.rows.length === 0) {
    throw new Error('Task assignment not found or cannot be completed');
  }

  const assignment = assignmentResult.rows[0];

  // Check if all assignments are completed
  const allAssignmentsResult = await query(
    `SELECT status FROM task_assignments WHERE task_id = $1`,
    [taskId]
  );

  const allCompleted = allAssignmentsResult.rows.every(
    (row) => row.status === 'completed'
  );

  if (allCompleted) {
    await query(
      `UPDATE tasks 
       SET status = 'completed', updated_at = NOW()
       WHERE id = $1`,
      [taskId]
    );
  }

  // Log status change
  await query(
    `INSERT INTO task_status_logs (
      id, task_id, assignment_id, old_status, new_status, changed_by_user_id, change_reason
    )
    VALUES (gen_random_uuid(), $1, $2, 'in_progress', 'completed', $3, 'Task completed')`,
    [taskId, assignment.id, userId]
  );

  return assignment as TaskAssignment;
};

/**
 * Get task assignments
 */
export const getTaskAssignments = async (taskId: string): Promise<TaskAssignment[]> => {
  const result = await query(
    `SELECT ta.*, u.name as assigned_to_name, u.profile_photo_url as assigned_to_photo
     FROM task_assignments ta
     INNER JOIN users u ON ta.assigned_to_user_id = u.id
     WHERE ta.task_id = $1
     ORDER BY ta.created_at ASC`,
    [taskId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    assignedToUserId: row.assigned_to_user_id,
    assignedByUserId: row.assigned_by_user_id,
    status: row.status,
    rejectionReason: row.rejection_reason,
    acceptedAt: row.accepted_at,
    rejectedAt: row.rejected_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assignedToName: row.assigned_to_name,
    assignedToPhoto: row.assigned_to_photo,
  })) as any[];
};

/**
 * Update task
 */
export const updateTask = async (
  taskId: string,
  userId: string,
  updates: {
    title?: string;
    description?: string;
    startDate?: Date;
    targetDate?: Date;
    dueDate?: Date;
  }
): Promise<Task> => {
  // Check if user is creator
  const taskResult = await query('SELECT creator_id FROM tasks WHERE id = $1', [taskId]);
  if (taskResult.rows.length === 0) {
    throw new Error('Task not found');
  }

  if (taskResult.rows[0].creator_id !== userId) {
    throw new Error('Only task creator can update task');
  }

  const updateFields: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (updates.title) {
    paramIndex++;
    updateFields.push(`title = $${paramIndex}`);
    params.push(updates.title);
  }

  if (updates.description !== undefined) {
    paramIndex++;
    updateFields.push(`description = $${paramIndex}`);
    params.push(updates.description);
  }

  if (updates.startDate) {
    paramIndex++;
    updateFields.push(`start_date = $${paramIndex}`);
    params.push(updates.startDate);
  }

  if (updates.targetDate) {
    paramIndex++;
    updateFields.push(`target_date = $${paramIndex}`);
    params.push(updates.targetDate);
  }

  if (updates.dueDate) {
    paramIndex++;
    updateFields.push(`due_date = $${paramIndex}`);
    params.push(updates.dueDate);
  }

  if (updateFields.length === 0) {
    throw new Error('No updates provided');
  }

  updateFields.push(`updated_at = NOW()`);
  params.push(taskId);

  const result = await query(
    `UPDATE tasks 
     SET ${updateFields.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING *`,
    params
  );

  return result.rows[0] as Task;
};

/**
 * Link compliance to task
 */
export const linkComplianceToTask = async (
  taskId: string,
  complianceId: string,
  userId: string,
  userRole: string,
  userOrganizationId: string | null | undefined
): Promise<void> => {
  // Verify task exists
  const taskResult = await query('SELECT organization_id FROM tasks WHERE id = $1', [taskId]);
  if (taskResult.rows.length === 0) {
    throw new Error('Task not found');
  }

  // Verify compliance exists and user has access
  const { getComplianceById } = await import('./complianceService');
  const compliance = await getComplianceById(complianceId, userId, userRole, userOrganizationId);
  if (!compliance) {
    throw new Error('Compliance not found or access denied');
  }

  // Update task with compliance_id
  await query(
    `UPDATE tasks SET compliance_id = $1, updated_at = NOW() WHERE id = $2`,
    [complianceId, taskId]
  );
};

/**
 * Unlink compliance from task
 */
export const unlinkComplianceFromTask = async (
  taskId: string,
  complianceId: string,
  userId: string
): Promise<void> => {
  // Verify task exists and user is creator
  const taskResult = await query('SELECT creator_id, compliance_id FROM tasks WHERE id = $1', [taskId]);
  if (taskResult.rows.length === 0) {
    throw new Error('Task not found');
  }

  if (taskResult.rows[0].creator_id !== userId) {
    throw new Error('Only task creator can unlink compliance');
  }

  if (taskResult.rows[0].compliance_id !== complianceId) {
    throw new Error('Compliance is not linked to this task');
  }

  await query(
    `UPDATE tasks SET compliance_id = NULL, updated_at = NOW() WHERE id = $1`,
    [taskId]
  );
};

/**
 * Get compliances linked to a task
 */
export const getCompliancesForTask = async (
  taskId: string,
  userId: string,
  userRole: string,
  userOrganizationId: string | null | undefined
): Promise<any[]> => {
  const result = await query(
    `SELECT cm.* FROM compliance_master cm
     INNER JOIN tasks t ON cm.id = t.compliance_id
     WHERE t.id = $1`,
    [taskId]
  );

  // Filter by access permissions
  const { getComplianceById } = await import('./complianceService');
  const accessibleCompliances = [];

  for (const row of result.rows) {
    const compliance = await getComplianceById(row.id, userId, userRole, userOrganizationId);
    if (compliance) {
      accessibleCompliances.push(compliance);
    }
  }

  return accessibleCompliances;
};

