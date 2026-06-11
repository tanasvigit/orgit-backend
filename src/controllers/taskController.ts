import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import { query, getClient } from '../config/database';
import { getReminderConfig } from '../services/platformSettingsService';
import { computeTaskAndMemberStatuses } from '../services/taskStatusEngine';
import {
  resolveInitialAssigneeStatus,
  resolveUserLifecycleCategory,
} from '../services/userTaskLifecycle';
import { logTaskActivity } from '../services/taskActivityLogger';
import {
  getComputedStatus,
  isValidTransition,
} from '../services/task-status-engine.service';
import { dispatchNotification } from '../services/notification-bus.service';
import { notifyNewTaskAssignees } from '../services/taskAssigneeNotification.service';
import {
  extractBaseTitle,
  formatRecurringTitle,
} from '../services/recurringTaskService';
import {
  setupRecurringTemplateForTask,
  loadOrganizationAccountingYearStart,
} from '../services/recurringTemplateSetup';
import {
  applyRecurrenceTimeOfDay,
  calculateNextCycleStartDate,
  startOfCalendarDay,
  startOfUtcCalendarDay,
} from '../services/cycleStartRecurrence';
import {
  buildRecurrenceEndFieldsForStorage,
  parseRecurrenceEndPolicy,
  validateRecurrenceEndPolicyInput,
} from '../services/recurrenceEndPolicy';
import {
  resolveNodeReference,
  resolveOrganizationIdForUser,
} from '../services/organizationStructureService';
import { deriveTaskUnitFromOrgPath, enrichTaskDisplayFields } from '../utils/taskDisplayFields';
import {
  buildEscalationRulesFromRequest,
  normalizeEscalationDaysBefore,
  normalizeEscalationTrigger,
} from '../services/taskEscalationHelpers';

let tasksDeletedAtColumnExists: boolean | null = null;

const getTasksDeletedAtFilter = async (): Promise<string> => {
  if (tasksDeletedAtColumnExists === null) {
    const columnExistsResult = await query(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.columns
         WHERE table_name = 'tasks'
           AND column_name = 'deleted_at'
       ) AS exists`
    );
    tasksDeletedAtColumnExists = Boolean(columnExistsResult.rows[0]?.exists);
  }

  return tasksDeletedAtColumnExists ? 'AND t.deleted_at IS NULL' : '';
};

/** Append to `FROM tasks WHERE id = $1` when `tasks.deleted_at` exists (same cache as getTasksDeletedAtFilter). */
const getTasksActiveByIdClause = async (): Promise<string> => {
  await getTasksDeletedAtFilter();
  return tasksDeletedAtColumnExists ? ' AND deleted_at IS NULL' : '';
};

let taskDeleteRequestsTableExists: boolean | null = null;
const tableExistsCache: Record<string, boolean> = {};

const getTaskDeleteRequestsTableExists = async (): Promise<boolean> => {
  if (taskDeleteRequestsTableExists === null) {
    const r = await query(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.tables
         WHERE table_name = 'task_delete_requests'
       ) AS exists`
    );
    taskDeleteRequestsTableExists = Boolean(r.rows[0]?.exists);
  }
  return taskDeleteRequestsTableExists;
};

const doesTableExist = async (tableName: string): Promise<boolean> => {
  if (tableName in tableExistsCache) return tableExistsCache[tableName];
  const r = await query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.tables
       WHERE table_name = $1
     ) AS exists`,
    [tableName]
  );
  const exists = Boolean(r.rows[0]?.exists);
  tableExistsCache[tableName] = exists;
  return exists;
};

const hardDeleteTaskAndRelations = async (
  client: { query: (text: string, values?: any[]) => Promise<any> },
  taskId: string
) => {
  // Remove task-group conversation payloads linked to this task first.
  const convResult = await client.query(
    `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE`,
    [taskId]
  );
  const conversationIds = convResult.rows.map((r: any) => String(r.id));

  if (conversationIds.length > 0) {
    if (await doesTableExist('message_status')) {
      await client.query(
        `DELETE FROM message_status
         WHERE message_id IN (
           SELECT id FROM messages WHERE conversation_id = ANY($1::uuid[])
         )`,
        [conversationIds]
      );
    }
    await client.query(`DELETE FROM messages WHERE conversation_id = ANY($1::uuid[])`, [conversationIds]);
    await client.query(`DELETE FROM conversation_members WHERE conversation_id = ANY($1::uuid[])`, [conversationIds]);
    await client.query(`DELETE FROM conversations WHERE id = ANY($1::uuid[])`, [conversationIds]);
  }

  // New task model tables.
  if (await doesTableExist('task_exit_requests')) {
    await client.query(`DELETE FROM task_exit_requests WHERE task_id = $1`, [taskId]);
  }
  if (await doesTableExist('task_delete_requests')) {
    await client.query(`DELETE FROM task_delete_requests WHERE task_id = $1`, [taskId]);
  }
  await client.query(`DELETE FROM task_activities WHERE task_id = $1`, [taskId]);
  await client.query(`DELETE FROM task_assignees WHERE task_id = $1`, [taskId]);

  // Legacy task model tables.
  if (await doesTableExist('task_status_logs')) {
    await client.query(`DELETE FROM task_status_logs WHERE task_id = $1`, [taskId]);
  }
  if (await doesTableExist('task_assignments')) {
    await client.query(`DELETE FROM task_assignments WHERE task_id = $1`, [taskId]);
  }
  if (await doesTableExist('groups')) {
    await client.query(`DELETE FROM groups WHERE task_id = $1`, [taskId]);
  }

  // Finally remove the task row itself.
  await client.query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
};

let messagesMetadataColumnExists: boolean | null = null;

const getMessagesMetadataColumnExists = async (): Promise<boolean> => {
  if (messagesMetadataColumnExists === null) {
    const r = await query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'messages' AND column_name = 'metadata'
       ) AS exists`
    );
    messagesMetadataColumnExists = Boolean(r.rows[0]?.exists);
  }
  return messagesMetadataColumnExists;
};

const normalizeTaskRecurrenceForClient = (task: any) => {
  if (!task || task.recurrence_type !== 'annually') {
    return task;
  }

  return {
    ...task,
    recurrence_type: 'yearly',
  };
};

/** Prefer user-entered client_name over linked entity display name in list/detail queries. */
const TASK_CLIENT_NAME_SQL = `COALESCE(NULLIF(TRIM(MAX(t.client_name)), ''), MAX(ce.name)) as client_name`;

/** System message for task group chat; older DBs may lack messages.metadata. */
const insertSystemMessageOptionalMetadata = async (
  client: { query: (text: string, values?: any[]) => Promise<any> },
  params: {
    conversationId: string;
    senderId: string;
    content: string;
    metadata: Record<string, unknown> | null;
  }
) => {
  const hasMeta = await getMessagesMetadataColumnExists();
  if (hasMeta) {
    await client.query(
      `INSERT INTO messages (conversation_id, sender_id, content, message_type, metadata)
       VALUES ($1, $2, $3, 'system', $4::jsonb)`,
      [params.conversationId, params.senderId, params.content, JSON.stringify(params.metadata)]
    );
  } else {
    await client.query(
      `INSERT INTO messages (conversation_id, sender_id, content, message_type)
       VALUES ($1, $2, $3, 'system')`,
      [params.conversationId, params.senderId, params.content]
    );
  }
};

const resolveSystemRequestActionChips = async (
  client: { query: (text: string, values?: any[]) => Promise<any> },
  params: {
    conversationId: string;
    requestType: 'task_exit' | 'task_delete';
    requestId?: string | null;
    decision: 'approved' | 'rejected' | 'denied';
  }
) => {
  const hasMeta = await getMessagesMetadataColumnExists();
  if (!hasMeta || !params.requestId) return;

  await client.query(
    `UPDATE messages
     SET metadata = jsonb_set(
       jsonb_set(COALESCE(metadata, '{}'::jsonb), '{actionChips}', '[]'::jsonb, true),
       '{decision}',
       to_jsonb($4::text),
       true
     )
     WHERE conversation_id = $1
       AND message_type = 'system'
       AND metadata->>'requestType' = $2
       AND metadata->>'requestId' = $3
       AND jsonb_typeof(metadata->'actionChips') = 'array'
       AND jsonb_array_length(metadata->'actionChips') > 0`,
    [params.conversationId, params.requestType, String(params.requestId), params.decision]
  );
};

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

const buildTaskWithDerivedStatus = (task: any) => {
  const normalizedTask = enrichTaskDisplayFields(normalizeTaskRecurrenceForClient(task));
  const computedStatus = getComputedStatus({
    id: String(normalizedTask.id),
    status: normalizedTask.status,
    start_date: normalizedTask.start_date,
    due_date: normalizedTask.due_date,
    deleted_at: normalizedTask.deleted_at,
  });

  return {
    ...normalizedTask,
    status: computedStatus.status,
    derived_status: computedStatus.derivedStatus,
  };
};

/**
 * Get all tasks for the authenticated user - matching message-backend
 */
export const getTasks = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { type, status, priority } = req.query;
    const includeAll = req.query.include_all === 'true';

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const deletedAtFilter = await getTasksDeletedAtFilter();

    let querySQL = `
      SELECT 
        t.*,
        ${TASK_CLIENT_NAME_SQL},
        (
          SELECT COALESCE(
            MAX(ta2.verified_at),
            MAX(ta2.completed_at)
          )
          FROM task_assignees ta2
          WHERE ta2.task_id = t.id
        ) AS completed_at,
        json_agg(
          DISTINCT jsonb_build_object(
            'id', u.id,
            'name', u.name,
            'phone', u.mobile,
            'mobile', u.mobile,
            'profile_photo', u.profile_photo_url,
            'profile_photo_url', u.profile_photo_url,
            'department', NULL,
            'designation', NULL,
            'status', u.status,
            'accepted_at', ta.accepted_at,
            'has_accepted', CASE WHEN ta.accepted_at IS NOT NULL THEN true ELSE false END,
            'completed_at', ta.completed_at,
            'verified_at', ta.verified_at,
            'assignee_status', ta.status,
            'role', ta.role
          )
        ) FILTER (WHERE u.id IS NOT NULL) as assignees,
        (
          SELECT COUNT(*)
          FROM task_assignees ta2
          WHERE ta2.task_id = t.id AND ta2.accepted_at IS NOT NULL
        ) as accepted_count,
        (
          SELECT COUNT(*)
          FROM task_assignees ta2
          WHERE ta2.task_id = t.id
        ) as total_assignees,
        (
          SELECT jsonb_build_object(
            'accepted_at', ta3.accepted_at,
            'has_accepted', CASE WHEN ta3.accepted_at IS NOT NULL THEN true ELSE false END,
            'assignee_status', ta3.status,
            'completed_at', ta3.completed_at,
            'verified_at', ta3.verified_at,
            'role', ta3.role
          )
          FROM task_assignees ta3
          WHERE ta3.task_id = t.id AND ta3.user_id = $1
        ) as current_user_status,
        c.id as conversation_id,
        c.name as conversation_name,
        (
          SELECT m.created_at
          FROM messages m
          WHERE c.id IS NOT NULL
            AND CAST(m.conversation_id AS TEXT) = CAST(c.id AS TEXT)
            AND m.is_deleted = FALSE
            AND m.deleted_at IS NULL
          ORDER BY m.created_at DESC
          LIMIT 1
        ) as last_message_time
      FROM tasks t
      LEFT JOIN task_assignees ta ON t.id = ta.task_id
      LEFT JOIN users u ON ta.user_id = u.id
      LEFT JOIN conversations c ON c.task_id = t.id AND c.is_task_group = TRUE
      LEFT JOIN client_entities ce ON t.client_entity_id = ce.id
      WHERE (
        EXISTS (
          SELECT 1 
          FROM task_assignees ta_check 
          WHERE ta_check.task_id = t.id AND ta_check.user_id = $1
        )
        OR COALESCE(t.created_by, t.creator_id) = $1
      )
      ${deletedAtFilter}
    `;

    const params: any[] = [userId];
    const conditions: string[] = [];

    // Exclude template controllers from normal task lists unless explicitly requested.
    if (type !== 'recurring_template') {
      conditions.push(`(COALESCE(t.is_recurring_template, false) = false AND COALESCE(t.task_type, 'one_time') != 'recurring_template')`);
    }

    // Filter by task type
    // Priority: task_type field takes precedence
    // - If task_type = 'one_time': always show in one_time (regardless of recurrence_type)
    // - If task_type = 'recurring_instance': always show in recurring bucket
    // - If task_type IS NULL: use recurrence_type to determine
    if (type === 'recurring') {
      // Show recurring tasks: new recurring instances OR legacy recurring rows.
      conditions.push(
        `(t.task_type = $${params.length + 1} OR t.task_type = $${params.length + 2} OR (t.task_type IS NULL AND t.recurrence_type IS NOT NULL))`
      );
      params.push('recurring_instance', 'recurring');

      // Recurring list uses the same lifecycle visibility as the dashboard (no due-date-only window).
    } else if (type === 'one_time') {
      // Show one-time tasks: explicitly marked as one_time OR (no type set AND no recurrence)
      conditions.push(`(t.task_type = $${params.length + 1} OR (t.task_type IS NULL AND t.recurrence_type IS NULL))`);
      params.push('one_time');
      // One-time list aligns with dashboard lifecycle (no due-date-only window).
    } else if (type === 'recurring_instance' || type === 'recurring_template') {
      conditions.push(`t.task_type = $${params.length + 1}`);
      params.push(type);
    }

    if (status) {
      conditions.push(`t.status = $${params.length + 1}`);
      params.push(status);
    }

    // Note: priority column doesn't exist in tasks table, so priority filter is removed
    // if (priority) {
    //   conditions.push(`t.priority = $${params.length + 1}`);
    //   params.push(priority);
    // }

    if (conditions.length > 0) {
      querySQL += ` AND ${conditions.join(' AND ')}`;
    }

    querySQL += `
      GROUP BY t.id, c.id, c.name
      ORDER BY 
        t.due_date ASC NULLS LAST,
        t.created_at DESC
    `;

    const result = await query(querySQL, params);
    const reminderConfig = await getReminderConfig();
    const dueSoonDays = reminderConfig.dueSoonDays;
    // Prevent caching so clients always get full body (avoid 304 with empty body breaking task list)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    const rowsWithStatus = result.rows.map((row: any) => {
      const assignees = Array.isArray(row.assignees) ? row.assignees : [];
      const computed = computeTaskAndMemberStatuses(row, assignees, userId);
      const totalAssignees =
        row.total_assignees != null
          ? Number(row.total_assignees)
          : Array.isArray(assignees)
          ? assignees.length
          : 0;
      const hideUserStatus =
        !row.start_date &&
        !row.target_date &&
        !row.due_date &&
        Number.isFinite(totalAssignees) &&
        totalAssignees === 0;
      const currentUserAssignee = assignees.find((a: any) => {
        const assigneeId = a?.id || a?.user_id || a?.userId;
        return assigneeId != null && String(assigneeId) === String(userId);
      });
      const currentUserLifecycleStatus = resolveUserLifecycleCategory({
        assigneeStatus:
          row.current_user_status?.assignee_status ?? currentUserAssignee?.assignee_status,
        verifiedAt: currentUserAssignee?.verified_at,
        startDate: row.start_date,
        targetDate: row.target_date,
        dueDate: row.due_date,
        dueSoonDays,
      });
      return {
        ...buildTaskWithDerivedStatus(row),
        task_status: computed.taskStatus,
        member_statuses: computed.memberStatuses,
        current_user_member_status: computed.currentUserMemberStatus,
        current_user_lifecycle_status: currentUserLifecycleStatus,
        is_before_start_date: currentUserLifecycleStatus === 'scheduled',
        hide_user_status: hideUserStatus,
      };
    });

    res.json({ tasks: rowsWithStatus, dueSoonDays });
  } catch (error: any) {
    console.error('Get tasks error:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
};

/**
 * Get a single task by ID - matching message-backend
 */
export const getTask = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const deletedAtFilter = await getTasksDeletedAtFilter();

    // First check if task exists and user has access
    const accessCheck = await query(
      `SELECT t.id 
       FROM tasks t
       WHERE t.id = $1 
         ${deletedAtFilter}
         AND (
           COALESCE(t.created_by, t.creator_id) = $2 
           OR EXISTS(
             SELECT 1 
             FROM task_assignees ta_check 
             WHERE ta_check.task_id = t.id AND ta_check.user_id = $2
           )
         )`,
      [id, userId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Now get the full task with all assignees (not filtered by user)
    const taskResult = await query(
      `SELECT 
        t.*,
        ${TASK_CLIENT_NAME_SQL},
        (
          SELECT COALESCE(
            MAX(ta2.verified_at),
            MAX(ta2.completed_at)
          )
          FROM task_assignees ta2
          WHERE ta2.task_id = t.id
        ) AS completed_at,
        json_agg(
          DISTINCT jsonb_build_object(
            'id', u.id,
            'name', u.name,
            'phone', u.mobile,
            'mobile', u.mobile,
            'profile_photo', u.profile_photo_url,
            'profile_photo_url', u.profile_photo_url,
            'department', NULL,
            'designation', NULL,
            'status', u.status,
            'accepted_at', ta.accepted_at,
            'has_accepted', CASE WHEN ta.accepted_at IS NOT NULL THEN true ELSE false END,
            'completed_at', ta.completed_at,
            'verified_at', ta.verified_at,
            'assignee_status', ta.status,
            'role', ta.role
          )
        ) FILTER (WHERE u.id IS NOT NULL) as assignees,
        (
          SELECT jsonb_build_object(
            'accepted_at', ta2.accepted_at,
            'has_accepted', CASE WHEN ta2.accepted_at IS NOT NULL THEN true ELSE false END,
            'assignee_status', ta2.status,
            'completed_at', ta2.completed_at,
            'verified_at', ta2.verified_at,
            'role', ta2.role
          )
          FROM task_assignees ta2
          WHERE ta2.task_id = t.id AND ta2.user_id = $2
        ) as current_user_status,
        c.id as conversation_id,
        c.name as conversation_name,
        creator.name as creator_name,
        creator.profile_photo_url as creator_photo,
        t.reporting_member_id,
        reporting_member.id as reporting_member_user_id,
        reporting_member.name as reporting_member_name,
        reporting_member.profile_photo_url as reporting_member_photo
      FROM tasks t
      LEFT JOIN task_assignees ta ON t.id = ta.task_id
      LEFT JOIN users u ON ta.user_id = u.id
      LEFT JOIN conversations c ON c.task_id = t.id AND c.is_task_group = TRUE
      LEFT JOIN users creator ON COALESCE(t.created_by, t.creator_id) = creator.id
      LEFT JOIN users reporting_member ON t.reporting_member_id = reporting_member.id
      LEFT JOIN client_entities ce ON t.client_entity_id = ce.id
      WHERE t.id = $1
        ${deletedAtFilter}
      GROUP BY t.id, c.id, c.name, creator.name, creator.profile_photo_url, t.reporting_member_id, reporting_member.id, reporting_member.name, reporting_member.profile_photo_url`,
      [id, userId]
    );

    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Get activity log
    const activitiesResult = await query(
      `SELECT 
        ta.*,
        u.name as user_name,
        u.profile_photo_url as user_photo
      FROM task_activities ta
      LEFT JOIN users u ON ta.user_id = u.id
      WHERE ta.task_id = $1
      ORDER BY ta.created_at DESC`,
      [id]
    );

    const task = taskResult.rows[0];
    task.activities = activitiesResult.rows;
    // Ensure creator_id is set for frontend (task owner; used for Verify button visibility)
    if (!task.creator_id && task.created_by) {
      task.creator_id = task.created_by;
    }

    const assignees = Array.isArray(task.assignees) ? task.assignees : [];
    const computed = computeTaskAndMemberStatuses(task, assignees, userId);
    const hideUserStatus =
      !task.start_date &&
      !task.target_date &&
      !task.due_date &&
      Array.isArray(assignees) &&
      assignees.length === 0;
    const taskWithDerived = buildTaskWithDerivedStatus(task);
    taskWithDerived.task_status = computed.taskStatus;
    (taskWithDerived as any).member_statuses = computed.memberStatuses;
    (taskWithDerived as any).hide_user_status = hideUserStatus;
    if (computed.currentUserMemberStatus) {
      (taskWithDerived as any).current_user_member_status = computed.currentUserMemberStatus;
    }
    const currentUserAssignee = assignees.find((a: any) => {
      const assigneeId = a?.id || a?.user_id || a?.userId;
      return assigneeId != null && String(assigneeId) === String(userId);
    });
    const reminderConfig = await getReminderConfig();
    const currentUserLifecycleStatus = resolveUserLifecycleCategory({
      assigneeStatus:
        task.current_user_status?.assignee_status ?? currentUserAssignee?.assignee_status,
      verifiedAt: currentUserAssignee?.verified_at,
      startDate: task.start_date,
      targetDate: task.target_date,
      dueDate: task.due_date,
      dueSoonDays: reminderConfig.dueSoonDays,
    });
    (taskWithDerived as any).current_user_lifecycle_status = currentUserLifecycleStatus;
    (taskWithDerived as any).is_before_start_date = currentUserLifecycleStatus === 'scheduled';

    res.json({ task: taskWithDerived, dueSoonDays: reminderConfig.dueSoonDays });
  } catch (error: any) {
    console.error('Get task error:', error);
    res.status(500).json({ error: 'Failed to fetch task' });
  }
};

/**
 * Create a new task - matching message-backend
 */
export const createTask = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const {
      title,
      description,
      client_name,
      task_type,
      priority,
      assignee_ids,
      start_date,
      target_date,
      due_date,
      recurrence_type,
      recurrence_interval,
      task_rollout_type,
      recurrence_day_of_month,
      specific_weekday,
      auto_escalate,
      escalation_rules,
      escalation_trigger,
      escalation_when,
      escalation_offset_days,
      escalation_days_before,
      escalation_contact_ids,
      compliance_id,
      reporting_member_id,
      // If provided, this is the actual task owner / creator of record
      // (used when User1 creates a task on behalf of User2)
      creator_id,
      // Financial fields from mobile app
      financial_value,
      finance_type,
      // Document management: link task to document instance or user document; category for dashboard grouping
      category,
      document_instance_id,
      document_id,
      client_entity_id,
      end_date,
      org_structure_node_id,
      task_unit,
      recurrence_end_type,
      recurrence_end_date,
      recurrence_after_occurrences,
    } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    // Determine actual task owner/creator
    const taskCreatorId: string = (creator_id && typeof creator_id === 'string' ? creator_id : userId) as string;
    const isDifferentOwner = taskCreatorId !== userId;
    const normalizedTaskTypeInput = task_type === 'recurring' ? 'recurring' : (task_type || 'one_time');
    const createRecurringTemplate = normalizedTaskTypeInput === 'recurring';
    const taskTypeForInsert = createRecurringTemplate ? 'recurring_instance' : normalizedTaskTypeInput;
    const recurringBaseTitle = extractBaseTitle(String(title || ''));
    const rawAssigneeIds = Array.isArray(assignee_ids) ? assignee_ids : [];
    const hasNoDates = !start_date && !target_date && !due_date;
    const allowOptionalDates = hasNoDates;

    // For recurring monthly tasks, allow deriving due_date from recurrence_day_of_month (no start_date used).
    // Skip derivation when optional-date creator-only flow is used.
    let finalDueDate: string | null = due_date || null;
    if (!allowOptionalDates && !finalDueDate && task_type === 'recurring' && recurrence_type === 'monthly' && recurrence_day_of_month) {
      const day = Math.max(1, Math.min(31, Number(recurrence_day_of_month)));
      const base = target_date ? new Date(target_date) : new Date();
      const year = base.getFullYear();
      const month = base.getMonth();
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const clampedDay = Math.min(day, daysInMonth);
      let candidate = new Date(year, month, clampedDay, 9, 0, 0, 0);
      const baseMidnight = new Date(base);
      baseMidnight.setHours(0, 0, 0, 0);
      if (candidate < baseMidnight) {
        const nextMonth = new Date(year, month + 1, 1);
        const nextDaysInMonth = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate();
        const nextClamped = Math.min(day, nextDaysInMonth);
        candidate = new Date(nextMonth.getFullYear(), nextMonth.getMonth(), nextClamped, 9, 0, 0, 0);
      }
      finalDueDate = candidate.toISOString();
    }

    if (!allowOptionalDates && !finalDueDate) {
      return res.status(400).json({ error: 'Due date is required' });
    }

    if (
      allowOptionalDates &&
      createRecurringTemplate &&
      (task_rollout_type !== 'cycle_start' || !recurrence_type)
    ) {
      return res.status(400).json({
        error: 'Recurring tasks without dates require recurrence_type and task_rollout_type = cycle_start',
      });
    }

    const recurrenceEndPolicy = parseRecurrenceEndPolicy({
      recurrence_end_type,
      recurrence_end_date,
      recurrence_after_occurrences,
    });
    if (createRecurringTemplate) {
      const endValidation = validateRecurrenceEndPolicyInput(recurrenceEndPolicy);
      if (!endValidation.valid) {
        return res.status(400).json({ error: endValidation.error });
      }
      if (
        recurrenceEndPolicy.endType === 'specific_date' &&
        recurrenceEndPolicy.endDate &&
        (start_date || finalDueDate || target_date)
      ) {
        const anchor = new Date((start_date || finalDueDate || target_date) as string);
        if (startOfCalendarDay(recurrenceEndPolicy.endDate).getTime() < startOfCalendarDay(anchor).getTime()) {
          return res.status(400).json({
            error: 'Recurrence end date cannot be before the first task cycle start date.',
          });
        }
      }
    }
    const recurrenceEndStorage = buildRecurrenceEndFieldsForStorage(
      recurrenceEndPolicy.endType,
      recurrence_end_date,
      recurrenceEndPolicy.maxOccurrences
    );

    let finalEscalationRules = buildEscalationRulesFromRequest({
      auto_escalate,
      escalation_rules,
      escalation_trigger,
      escalation_when,
      escalation_offset_days,
      escalation_days_before,
      escalation_contact_ids,
    });

    const normalizedEscalationTrigger = auto_escalate
      ? normalizeEscalationTrigger(
          escalation_trigger ?? finalEscalationRules?.trigger
        )
      : null;
    const normalizedEscalationDaysBefore = auto_escalate
      ? normalizeEscalationDaysBefore(
          escalation_days_before ?? finalEscalationRules?.days_before
        )
      : null;
    const escalationContactIds: string[] =
      auto_escalate && Array.isArray(escalation_contact_ids)
        ? Array.from(
            new Set(
              escalation_contact_ids
                .map((id: unknown) => (id != null ? String(id).trim() : ''))
                .filter(Boolean)
            )
          )
        : Array.isArray(finalEscalationRules?.contact_ids)
          ? finalEscalationRules.contact_ids.map(String)
          : [];

    if (finalEscalationRules && escalationContactIds.length > 0) {
      finalEscalationRules = {
        ...finalEscalationRules,
        contact_ids: escalationContactIds,
      };
    }

    // If the task is being created on behalf of another user, store metadata in escalation_rules.
    if (isDifferentOwner && finalEscalationRules) {
      finalEscalationRules = {
        ...finalEscalationRules,
        _metadata: {
          ...(finalEscalationRules._metadata || {}),
          original_creator_id: userId,
          task_creator_id: taskCreatorId,
        },
      };
    }

    // Get user's organization_id
    let organizationId = await resolveOrganizationIdForUser(userId, req.user?.organizationId || null);
    
    // Check if organization_id column exists and is required
    const orgIdColumnCheck = await client.query(
      `SELECT column_name, is_nullable 
       FROM information_schema.columns 
       WHERE table_name = 'tasks' AND column_name = 'organization_id'`
    );
    const orgIdColumn = orgIdColumnCheck.rows[0];
    const requiresOrganizationId = orgIdColumn && orgIdColumn.is_nullable === 'NO';
    
    if (requiresOrganizationId && !organizationId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: 'Organization ID is required. User must be associated with an organization.' 
      });
    }

    let orgStructureReference:
      | {
          nodeId: string;
          levelKey: string;
          levelLabel: string;
          levelNumber: number;
          path: Array<{
            id: string;
            name: string;
            code: string;
            levelNumber: number;
            levelKey: string;
            levelLabel: string;
            status: 'active' | 'inactive' | 'archived';
          }>;
          pathDisplay: string;
        }
      | null = null;

    if (organizationId && typeof org_structure_node_id === 'string' && org_structure_node_id.trim()) {
      orgStructureReference = await resolveNodeReference(organizationId, org_structure_node_id.trim(), {
        activeOnly: true,
      });
    }

    let orgStructurePathForInsert: string | null = orgStructureReference?.path
      ? JSON.stringify(orgStructureReference.path)
      : null;
    let orgStructureNodeIdForInsert: string | null = orgStructureReference?.nodeId || null;
    let orgStructureLevelKeyForInsert: string | null = orgStructureReference?.levelKey || null;

    // Free-text task unit when no org node is linked (legacy column removed; store minimal path JSON).
    if (
      !orgStructureNodeIdForInsert &&
      typeof task_unit === 'string' &&
      task_unit.trim()
    ) {
      orgStructurePathForInsert = JSON.stringify([{ name: task_unit.trim() }]);
    }

    // Validate reporting_member_id if provided
    if (reporting_member_id) {
      // Ensure assignee_ids is provided and reporting_member_id is in the list
      if (!assignee_ids || !Array.isArray(assignee_ids)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: 'assignee_ids must be provided as an array when reporting_member_id is specified' 
        });
      }
      
      // Check if reporting_member_id is in assignee_ids
      if (!assignee_ids.includes(reporting_member_id)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: 'reporting_member_id must be one of the selected assignees' 
        });
      }
    }

    // Idempotency: if document_instance_id or document_id is provided, return existing task if one already exists for this document
    const documentInstanceId = document_instance_id && typeof document_instance_id === 'string' ? document_instance_id.trim() : null;
    const documentId = document_id && typeof document_id === 'string' ? document_id.trim() : null;
    if (documentInstanceId) {
      const existingTaskResult = await client.query(
        `SELECT * FROM tasks WHERE document_instance_id = $1 LIMIT 1`,
        [documentInstanceId]
      );
      if (existingTaskResult.rows.length > 0) {
        await client.query('COMMIT');
        return res.status(200).json({
          task: existingTaskResult.rows[0],
          message: 'Task already exists for this document',
        });
      }
    }
    if (documentId) {
      const docIdCheck = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'document_id'`
      );
      if (docIdCheck.rows.length > 0) {
        const existingTaskResult = await client.query(
          `SELECT * FROM tasks WHERE document_id = $1 LIMIT 1`,
          [documentId]
        );
        if (existingTaskResult.rows.length > 0) {
          await client.query('COMMIT');
          return res.status(200).json({
            task: existingTaskResult.rows[0],
            message: 'Task already exists for this document',
          });
        }
      }
    }

    // Insert task
    // Check which columns exist - handle both created_by and creator_id, organization_id,
    // compliance_id, reporting_member_id, and financial fields
    const columnCheck = await client.query(
      `SELECT column_name FROM information_schema.columns 
       WHERE table_name = 'tasks' 
         AND column_name IN (
           'created_by',
           'creator_id',
           'organization_id',
           'compliance_id',
           'reporting_member_id',
           'financial_value',
           'finance_type',
           'frequency',
           'specific_weekday',
           'next_recurrence_date',
           'category',
           'document_instance_id',
           'document_id',
           'client_entity_id',
           'client_name',
           'org_structure_node_id',
           'org_structure_level_key',
           'org_structure_path',
           'end_date',
           'status',
           'auto_escalate',
           'escalation_rules',
           'escalation_status',
           'escalation_trigger',
           'escalation_days_before',
           'recurrence_end_type',
           'recurrence_end_date',
           'recurrence_after_occurrences'
         )`
    );
    const hasCreatedBy = columnCheck.rows.some((r: any) => r.column_name === 'created_by');
    const hasCreatorId = columnCheck.rows.some((r: any) => r.column_name === 'creator_id');
    const hasOrganizationId = columnCheck.rows.some((r: any) => r.column_name === 'organization_id');
    const hasComplianceId = columnCheck.rows.some((r: any) => r.column_name === 'compliance_id');
    const hasReportingMemberId = columnCheck.rows.some((r: any) => r.column_name === 'reporting_member_id');
    const hasFinancialValue = columnCheck.rows.some((r: any) => r.column_name === 'financial_value');
    const hasFinanceType = columnCheck.rows.some((r: any) => r.column_name === 'finance_type');
    const hasFrequency = columnCheck.rows.some((r: any) => r.column_name === 'frequency');
    const hasSpecificWeekday = columnCheck.rows.some((r: any) => r.column_name === 'specific_weekday');
    const hasNextRecurrenceDate = columnCheck.rows.some((r: any) => r.column_name === 'next_recurrence_date');
    const hasCategory = columnCheck.rows.some((r: any) => r.column_name === 'category');
    const hasDocumentInstanceId = columnCheck.rows.some((r: any) => r.column_name === 'document_instance_id');
    const hasDocumentId = columnCheck.rows.some((r: any) => r.column_name === 'document_id');
    const hasClientEntityId = columnCheck.rows.some((r: any) => r.column_name === 'client_entity_id');
    const hasClientName = columnCheck.rows.some((r: any) => r.column_name === 'client_name');
    const hasOrgStructureNodeId = columnCheck.rows.some((r: any) => r.column_name === 'org_structure_node_id');
    const hasOrgStructureLevelKey = columnCheck.rows.some((r: any) => r.column_name === 'org_structure_level_key');
    const hasOrgStructurePath = columnCheck.rows.some((r: any) => r.column_name === 'org_structure_path');
    const hasEndDate = columnCheck.rows.some((r: any) => r.column_name === 'end_date');
    const hasStatusColumn = columnCheck.rows.some((r: any) => r.column_name === 'status');
    const hasTaskRolloutType = columnCheck.rows.some((r: any) => r.column_name === 'task_rollout_type');
    const hasAutoEscalate = columnCheck.rows.some((r: any) => r.column_name === 'auto_escalate');
    const hasEscalationRules = columnCheck.rows.some((r: any) => r.column_name === 'escalation_rules');
    const hasEscalationStatus = columnCheck.rows.some((r: any) => r.column_name === 'escalation_status');
    const hasEscalationTrigger = columnCheck.rows.some((r: any) => r.column_name === 'escalation_trigger');
    const hasEscalationDaysBefore = columnCheck.rows.some(
      (r: any) => r.column_name === 'escalation_days_before'
    );
    const hasRecurrenceEndType = columnCheck.rows.some((r: any) => r.column_name === 'recurrence_end_type');
    const hasRecurrenceEndDate = columnCheck.rows.some((r: any) => r.column_name === 'recurrence_end_date');
    const hasRecurrenceAfterOccurrences = columnCheck.rows.some(
      (r: any) => r.column_name === 'recurrence_after_occurrences'
    );

    const normalizedRecurrenceType =
      typeof recurrence_type === 'string' ? recurrence_type.toLowerCase() : null;
    const recurrenceTypeForStorage =
      normalizedRecurrenceType === 'yearly' ? 'annually' : normalizedRecurrenceType;
    // Weekly schedules are day-of-week based, so we store them as specific_weekday frequency.
    const frequency =
      normalizedRecurrenceType === 'daily'
        ? 'daily'
        : normalizedRecurrenceType === 'weekly'
        ? 'specific_weekday'
        : normalizedRecurrenceType === 'monthly' ||
          normalizedRecurrenceType === 'quarterly' ||
          normalizedRecurrenceType === 'annually' ||
          normalizedRecurrenceType === 'yearly' ||
          normalizedRecurrenceType === 'specific_weekday'
        ? normalizedRecurrenceType === 'annually'
          ? 'yearly'
          : normalizedRecurrenceType
        : null;
    let accountingYearStart: string | null = null;
    if (
      organizationId &&
      (normalizedRecurrenceType === 'yearly' || normalizedRecurrenceType === 'annually')
    ) {
      accountingYearStart =
        (await loadOrganizationAccountingYearStart(client, organizationId)) || '2000-04-01';
    }
    const normalizedSpecificWeekdayRaw =
      typeof specific_weekday === 'number'
        ? specific_weekday
        : typeof specific_weekday === 'string'
        ? Number(specific_weekday)
        : null;
    const normalizedSpecificWeekday =
      normalizedSpecificWeekdayRaw !== null && !Number.isNaN(normalizedSpecificWeekdayRaw)
        ? normalizedSpecificWeekdayRaw
        : null;
    const fallbackSpecificWeekday =
      finalDueDate
        ? new Date(finalDueDate).getDay()
        : start_date
        ? new Date(start_date).getDay()
        : null;
    const specificWeekdayValue =
      frequency === 'specific_weekday'
        ? normalizedSpecificWeekday !== null
          ? normalizedSpecificWeekday
          : fallbackSpecificWeekday
        : null;
    const cycleAnchorDate =
      start_date || finalDueDate || target_date
        ? new Date((start_date || finalDueDate || target_date) as string)
        : null;
    const normalizedCycleAnchorDate =
      normalizedRecurrenceType === 'daily' && cycleAnchorDate
        ? startOfUtcCalendarDay(cycleAnchorDate)
        : cycleAnchorDate;
    const nextRecurrenceDate =
      createRecurringTemplate &&
      normalizedCycleAnchorDate &&
      normalizedRecurrenceType
        ? calculateNextCycleStartDate(
            recurrenceTypeForStorage || normalizedRecurrenceType,
            recurrence_interval || 1,
            specificWeekdayValue,
            normalizedCycleAnchorDate,
            normalizedRecurrenceType === 'yearly' || normalizedRecurrenceType === 'annually'
              ? accountingYearStart
              : null
          )
        : null;

    // Determine initial task.status for recurring tasks at creation time so the first cycle behaves like later recurrences.
    let initialStatusForInsert: string | null = null;
    if (createRecurringTemplate && finalDueDate) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const due = new Date(finalDueDate);
      const dueMidnight = new Date(due);
      dueMidnight.setHours(0, 0, 0, 0);
      const diffMs = dueMidnight.getTime() - today.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      // New tasks should always start as pending/todo for both creator and assignees.
      // They move to in_progress only through explicit workflow actions.
      if (diffDays <= 0) {
        initialStatusForInsert = 'pending';
      } else {
        // Keep as pending (todo) for future-due tasks as well.
        initialStatusForInsert = 'pending';
      }
    }
    
    // Build INSERT statement with both columns if they exist
    let insertColumns = ['title', 'description', 'task_type'];
    const instanceTitle =
      createRecurringTemplate && normalizedCycleAnchorDate
        ? formatRecurringTitle(
            recurringBaseTitle,
            normalizedCycleAnchorDate,
            recurrenceTypeForStorage || normalizedRecurrenceType
          )
        : title;
    let insertValues = [instanceTitle, description, taskTypeForInsert];
    let paramIndex = 4;

    // If tasks table has a status column, set initial status for recurring tasks
    if (hasStatusColumn && initialStatusForInsert) {
      insertColumns.push('status');
      insertValues.push(initialStatusForInsert);
      paramIndex += 1;
    }
    
    // Add creator column(s) - set both if both exist
    if (hasCreatedBy && hasCreatorId) {
      // Both columns exist - set both to taskCreatorId
      insertColumns.push('created_by', 'creator_id');
      insertValues.push(taskCreatorId, taskCreatorId);
      paramIndex += 2;
    } else if (hasCreatedBy) {
      insertColumns.push('created_by');
      insertValues.push(taskCreatorId);
      paramIndex += 1;
    } else if (hasCreatorId) {
      insertColumns.push('creator_id');
      insertValues.push(taskCreatorId);
      paramIndex += 1;
    } else {
      // Default to created_by if neither exists (shouldn't happen, but safety)
      insertColumns.push('created_by');
      insertValues.push(taskCreatorId);
      paramIndex += 1;
    }
    
    // Add organization_id if column exists
    if (hasOrganizationId) {
      insertColumns.push('organization_id');
      insertValues.push(organizationId);
      paramIndex += 1;
    }

    // Add compliance_id if column exists and provided
    if (hasComplianceId && compliance_id) {
      insertColumns.push('compliance_id');
      insertValues.push(compliance_id);
      paramIndex += 1;
    }

    // Add reporting_member_id if column exists and provided
    if (hasReportingMemberId && reporting_member_id) {
      insertColumns.push('reporting_member_id');
      insertValues.push(reporting_member_id);
      paramIndex += 1;
    }
    
    // Add remaining columns
    const normalizedStartDateForInsert =
      createRecurringTemplate && normalizedRecurrenceType === 'daily' && start_date
        ? applyRecurrenceTimeOfDay(
            startOfUtcCalendarDay(new Date(start_date as string)),
            new Date(start_date as string)
          ).toISOString()
        : start_date || null;
    insertColumns.push('start_date', 'target_date', 'due_date');
    insertValues.push(normalizedStartDateForInsert, target_date || null, finalDueDate || null);

    if (hasFrequency) {
      insertColumns.push('frequency');
      insertValues.push(frequency);
    }
    if (hasSpecificWeekday) {
      insertColumns.push('specific_weekday');
      insertValues.push(specificWeekdayValue);
    }
    if (hasNextRecurrenceDate) {
      insertColumns.push('next_recurrence_date');
      insertValues.push(nextRecurrenceDate ? nextRecurrenceDate.toISOString() : null);
    }

    if (hasAutoEscalate) {
      insertColumns.push('auto_escalate');
      insertValues.push(!!auto_escalate);
    }
    if (hasEscalationRules) {
      insertColumns.push('escalation_rules');
      insertValues.push(finalEscalationRules ? JSON.stringify(finalEscalationRules) : null);
    }
    if (hasEscalationStatus) {
      insertColumns.push('escalation_status');
      insertValues.push('none');
    }
    if (hasEscalationTrigger && auto_escalate) {
      insertColumns.push('escalation_trigger');
      insertValues.push(normalizedEscalationTrigger || 'due_date');
    }
    if (hasEscalationDaysBefore && auto_escalate) {
      insertColumns.push('escalation_days_before');
      insertValues.push(normalizedEscalationDaysBefore ?? 0);
    }

    insertColumns.push('recurrence_type', 'recurrence_interval');
    insertValues.push(recurrenceTypeForStorage || null, recurrence_interval || 1);

    if (hasTaskRolloutType && createRecurringTemplate) {
      insertColumns.push('task_rollout_type');
      insertValues.push('cycle_start');
    }
    if (createRecurringTemplate && hasRecurrenceEndType) {
      insertColumns.push('recurrence_end_type');
      insertValues.push(recurrenceEndStorage.recurrence_end_type);
    }
    if (createRecurringTemplate && hasRecurrenceEndDate) {
      insertColumns.push('recurrence_end_date');
      insertValues.push(recurrenceEndStorage.recurrence_end_date);
    }
    if (createRecurringTemplate && hasRecurrenceAfterOccurrences) {
      insertColumns.push('recurrence_after_occurrences');
      insertValues.push(recurrenceEndStorage.recurrence_after_occurrences);
    }

    // Add financial fields if corresponding columns exist
    if (hasFinancialValue) {
      insertColumns.push('financial_value');
      insertValues.push(
        typeof financial_value === 'number'
          ? financial_value
          : financial_value
          ? Number(financial_value)
          : null
      );
    }

    if (hasFinanceType) {
      insertColumns.push('finance_type');
      const normalizedType =
        typeof finance_type === 'string' ? finance_type.toLowerCase() : null;
      insertValues.push(
        normalizedType === 'income' || normalizedType === 'expense'
          ? normalizedType
          : null
      );
    }

    if (hasCategory && category != null && typeof category === 'string') {
      insertColumns.push('category');
      insertValues.push(category.trim() || 'general');
    }

    if (hasDocumentInstanceId && documentInstanceId) {
      insertColumns.push('document_instance_id');
      insertValues.push(documentInstanceId);
    }

    if (hasDocumentId && documentId) {
      insertColumns.push('document_id');
      insertValues.push(documentId);
    }

    if (hasClientEntityId && client_entity_id) {
      insertColumns.push('client_entity_id');
      insertValues.push(client_entity_id);
    }

    if (hasClientName) {
      const normalizedClientName =
        typeof client_name === 'string' && client_name.trim().length > 0
          ? client_name.trim()
          : null;
      insertColumns.push('client_name');
      insertValues.push(normalizedClientName);
    }

    if (hasOrgStructureNodeId) {
      insertColumns.push('org_structure_node_id');
      insertValues.push(orgStructureNodeIdForInsert);
    }

    if (hasOrgStructureLevelKey) {
      insertColumns.push('org_structure_level_key');
      insertValues.push(orgStructureLevelKeyForInsert);
    }

    if (hasOrgStructurePath) {
      insertColumns.push('org_structure_path');
      insertValues.push(orgStructurePathForInsert);
    }

    if (hasEndDate && end_date) {
      insertColumns.push('end_date');
      insertValues.push(end_date);
    }

    // Recurring instances should keep explicit linkage fields when available.
    const hasParentTaskId = columnCheck.rows.some((r: any) => r.column_name === 'parent_task_id');
    const hasRecurrenceTemplateId = columnCheck.rows.some((r: any) => r.column_name === 'recurrence_template_id');
    const hasRecurrenceInstanceNo = columnCheck.rows.some((r: any) => r.column_name === 'recurrence_instance_no');
    if (createRecurringTemplate) {
      if (hasParentTaskId) {
        insertColumns.push('parent_task_id');
        insertValues.push(null);
      }
      if (hasRecurrenceTemplateId) {
        insertColumns.push('recurrence_template_id');
        insertValues.push(null);
      }
      if (hasRecurrenceInstanceNo) {
        insertColumns.push('recurrence_instance_no');
        insertValues.push(1);
      }
    }
    
    // Build parameterized query
    const placeholders = insertValues.map((_, i) => `$${i + 1}`).join(', ');
    
    const taskResult = await client.query(
      `INSERT INTO tasks (${insertColumns.join(', ')})
       VALUES (${placeholders})
       RETURNING *`,
      insertValues
    );

    const task = enrichTaskDisplayFields({
      ...taskResult.rows[0],
      task_unit:
        deriveTaskUnitFromOrgPath(orgStructureReference?.path) ||
        (typeof task_unit === 'string' && task_unit.trim() ? task_unit.trim() : null),
    });

    // Assign task to users.
    // IMPORTANT: If no assignee_ids are provided, we keep the task unassigned (no task_assignees rows).
    // The creator can still see it via tasks.created_by / tasks.creator_id.
    let hasAssignees = false;
    const rawIds = rawAssigneeIds;
    const hasExplicitAssignees = rawIds.length > 0;
    const allAssigneeIds = new Set<string>(
      rawIds.map((id: any) => (id != null ? String(id) : '').trim()).filter(Boolean)
    );

    if (hasExplicitAssignees) {
      // Always add task owner (actual creator) as assignee so creator sees the task
      allAssigneeIds.add(String(taskCreatorId));
      // When task owner is self, ensure the creating user is always an assignee (visibility)
      if (!isDifferentOwner) {
        allAssigneeIds.add(String(userId));
      }

      // CRITICAL: If requester is different from owner, ensure requester is NOT an assignee
      // This prevents User1 from seeing the task and from joining the task group conversation.
      if (isDifferentOwner) {
        allAssigneeIds.delete(String(userId));
      }
    }

    const assigneeStatus = resolveInitialAssigneeStatus({ startDate: task.start_date });

    if (hasExplicitAssignees && allAssigneeIds.size > 0) {
      hasAssignees = true;
      for (const assigneeId of allAssigneeIds) {
        const role =
          String(assigneeId) === String(taskCreatorId)
            ? 'creator'
            : reporting_member_id && String(assigneeId) === String(reporting_member_id)
            ? 'reporting_member'
            : 'member';
        await client.query(
          `INSERT INTO task_assignees (task_id, user_id, status, role, accepted_at)
           VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
           ON CONFLICT (task_id, user_id) DO UPDATE
           SET status = EXCLUDED.status,
               accepted_at = COALESCE(task_assignees.accepted_at, CURRENT_TIMESTAMP)`,
          [task.id, assigneeId, assigneeStatus, role]
        );
      }
      // Keep task as 'pending' when assignees are added; task moves to 'in_progress' only after assignee(s) accept.
    } else {
      // Keep creator as assignee for no-assignee creates too.
      hasAssignees = true;
      await client.query(
        `INSERT INTO task_assignees (task_id, user_id, status, role, accepted_at)
         VALUES ($1, $2, $3, 'creator', CURRENT_TIMESTAMP)
         ON CONFLICT (task_id, user_id) DO UPDATE
         SET status = EXCLUDED.status,
             accepted_at = COALESCE(task_assignees.accepted_at, CURRENT_TIMESTAMP)`,
        [task.id, taskCreatorId, assigneeStatus]
      );
    }

    // Recurring templates: persist immutable schedule controller and link this row as first instance.

    // Create task activity log
    const initialStatus = 'pending';
    await logTaskActivity(client, {
      taskId: task.id,
      userId,
      activityType: 'created',
      newValue: initialStatus,
      message: `Task "${task.title}" is created`,
    });

    // Auto-create task group conversation
    const conversationResult = await client.query(
      `INSERT INTO conversations (id, type, name, is_group, is_task_group, task_id, created_by)
       VALUES (gen_random_uuid(), 'group', $1, TRUE, TRUE, $2, $3)
       RETURNING *`,
      [`Task: ${task.title}`, task.id, taskCreatorId]
    );

    const conversation = conversationResult.rows[0];

    // Get task owner's name for the welcome message
    const creatorResult = await client.query(
      `SELECT name FROM users WHERE id = $1`,
      [taskCreatorId]
    );
    const creatorName = creatorResult.rows[0]?.name || 'Admin';

    // Add creator and assignees to conversation immediately (no separate accept step).
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       VALUES ($1, $2, 'admin')
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversation.id, taskCreatorId]
    );
    for (const assigneeId of allAssigneeIds) {
      if (String(assigneeId) === String(taskCreatorId)) continue;
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [conversation.id, assigneeId]
      );
    }

    // EXTRA SAFETY: ensure requester isn't in the conversation if they created on behalf of someone else
    if (isDifferentOwner) {
      await client.query(
        `DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
        [conversation.id, userId]
      );
    }

    if (auto_escalate && escalationContactIds.length > 0) {
      for (const escalationUserId of escalationContactIds) {
        if (!escalationUserId) continue;
        await client.query(
          `INSERT INTO task_assignees (task_id, user_id, status, role, accepted_at)
           VALUES ($1, $2, $3, 'escalation_contact', CURRENT_TIMESTAMP)
           ON CONFLICT (task_id, user_id) DO UPDATE
           SET role = 'escalation_contact',
               accepted_at = COALESCE(task_assignees.accepted_at, CURRENT_TIMESTAMP)`,
          [task.id, escalationUserId, assigneeStatus]
        );
        await client.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT (conversation_id, user_id) DO NOTHING`,
          [conversation.id, escalationUserId]
        );
      }
    }

    if (createRecurringTemplate) {
      await setupRecurringTemplateForTask(client, {
        task,
        organizationId: organizationId || null,
        title: recurringBaseTitle,
        description: description || null,
        category: category || null,
        creatorId: taskCreatorId,
        reportingMemberId: reporting_member_id || null,
        recurrenceType: recurrenceTypeForStorage || null,
        recurrenceInterval: recurrence_interval || 1,
        recurrenceDayOfMonth: recurrence_day_of_month || null,
        specificWeekday: specificWeekdayValue || null,
        nextRecurrenceDate,
        recurrenceEndType: recurrenceEndStorage.recurrence_end_type,
        recurrenceEndDate: recurrenceEndStorage.recurrence_end_date,
        recurrenceAfterOccurrences: recurrenceEndStorage.recurrence_after_occurrences,
        assigneeIds:
          allAssigneeIds.size > 0 ? allAssigneeIds : new Set<string>([String(taskCreatorId)]),
        escalationContactIds,
      });
    }

    // Create auto-generated message in task group
    // Check which columns exist in messages table
    const messageColumnCheck = await client.query(
      `SELECT column_name FROM information_schema.columns 
       WHERE table_name = 'messages' AND column_name = 'sender_organization_id'`
    );
    const hasSenderOrgId = messageColumnCheck.rows.some((r: any) => r.column_name === 'sender_organization_id');
    
    // Build INSERT statement - use conversation_id (new schema), not group_id (old schema)
    // The conversation_id is sufficient for task group messages. Read/delivery status is in message_status, not messages.
    let messageColumns = ['conversation_id', 'sender_id', 'content', 'message_type'];
    let messageValues: any[] = [conversation.id, taskCreatorId, `Task group auto-created by ${creatorName}`, 'text'];
    
    // Add sender_organization_id if column exists
    if (hasSenderOrgId && organizationId) {
      messageColumns.push('sender_organization_id');
      messageValues.push(organizationId);
    }
    
    // Build parameterized query
    const messagePlaceholders = messageValues.map((_, i) => `$${i + 1}`).join(', ');
    
    const messageResult = await client.query(
      `INSERT INTO messages (${messageColumns.join(', ')})
       VALUES (${messagePlaceholders})
       RETURNING id`,
      messageValues
    );
    
    const messageId = messageResult.rows[0].id;
    
    // Create message_status entry for the sender
    // Check if message_status table uses status_at or created_at
    try {
      await client.query(
        `INSERT INTO message_status (message_id, user_id, status, status_at)
         VALUES ($1, $2, 'sent', NOW())`,
        [messageId, taskCreatorId]
      );
    } catch (error: any) {
      // If error is about column name, try with created_at
      if (error.message && error.message.includes('created_at')) {
        await client.query(
          `INSERT INTO message_status (message_id, user_id, status, created_at)
           VALUES ($1, $2, 'sent', NOW())`,
          [messageId, taskCreatorId]
        );
      } else {
        // If message_status table doesn't exist or has different structure, log warning
        console.warn('[createTask] Could not create message_status entry:', error.message);
      }
    }

    await client.query('COMMIT');

    // Notify all assignees (same flow as addTaskAssignees): TASK_ASSIGNED + task group unread + socket refresh.
    try {
      const io = (req.app as any).get('io');
      const notifyAssigneeIds = new Set<string>(
        Array.from(allAssigneeIds).map((id) => String(id)).filter(Boolean)
      );
      if (auto_escalate) {
        for (const escalationUserId of escalationContactIds) {
          if (escalationUserId) notifyAssigneeIds.add(String(escalationUserId));
        }
      }

      await notifyNewTaskAssignees({
        io,
        taskId: task.id,
        conversationId: conversation.id,
        newAssigneeIds: Array.from(notifyAssigneeIds),
        addedByUserId: taskCreatorId,
        taskTitle: task.title,
      });
    } catch (notifyError: any) {
      console.warn('[createTask] Assignee notification failed:', notifyError?.message || notifyError);
    }

    // Fetch full task with assignees
    const fullTaskResult = await query(
      `SELECT 
        t.*,
        ${TASK_CLIENT_NAME_SQL},
        json_agg(
          DISTINCT jsonb_build_object(
            'id', u.id,
            'name', u.name,
            'phone', u.mobile,
            'profile_photo', u.profile_photo_url,
            'assignee_status', ta.status,
            'role', ta.role
          )
        ) FILTER (WHERE u.id IS NOT NULL) as assignees,
        $1::uuid as conversation_id
      FROM tasks t
      LEFT JOIN task_assignees ta ON t.id = ta.task_id
      LEFT JOIN users u ON ta.user_id = u.id
      LEFT JOIN client_entities ce ON t.client_entity_id = ce.id
      WHERE t.id = $2
      GROUP BY t.id`,
      [conversation.id, task.id]
    );

    res.status(201).json({ task: buildTaskWithDerivedStatus(fullTaskResult.rows[0]) });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Create task error:', error);
    res.status(500).json({ error: 'Failed to create task' });
  } finally {
    client.release();
  }
};

/**
 * Accept a task - matching message-backend
 */
export const acceptTask = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check if user is creator or assignee (must be in task_assignees to set in progress)
    const assigneeCheck = await client.query(
      `SELECT * FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (assigneeCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You are not assigned to this task' });
    }

    const alreadyAccepted = !!assigneeCheck.rows[0].accepted_at;

    // Accept: only set accepted_at. Assignee status (todo/inprogress) does NOT change here; use In Progress toggle for that.
    await client.query(
      `UPDATE task_assignees 
       SET accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP)
       WHERE task_id = $1 AND user_id = $2`,
      [id, userId]
    );

    // Add user to task group conversation when they first accept
    if (!alreadyAccepted) {
      const conversationResult = await client.query(
        `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
        [id]
      );

      if (conversationResult.rows.length > 0) {
        const taskInfo = await client.query(
          `SELECT COALESCE(created_by, creator_id) as task_creator_id, escalation_rules
           FROM tasks WHERE id = $1`,
          [id]
        );

        const taskCreatorId = taskInfo.rows[0]?.task_creator_id;
        const rules = taskInfo.rows[0]?.escalation_rules;
        const originalCreatorId = rules?._metadata?.original_creator_id;

        const isOriginalCreator = !!originalCreatorId && originalCreatorId === userId;
        const shouldAddToConversation = !isOriginalCreator || taskCreatorId === userId;

        if (shouldAddToConversation) {
          await client.query(
            `INSERT INTO conversation_members (conversation_id, user_id, role)
             VALUES ($1, $2, 'member')
             ON CONFLICT (conversation_id, user_id) DO NOTHING`,
            [conversationResult.rows[0].id, userId]
          );
        }
      }
    }

    await client.query('COMMIT');
    res.json({
      message: alreadyAccepted ? 'Task already accepted' : 'Task accepted',
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Accept task error:', error);
    res.status(500).json({ error: 'Failed to accept task' });
  } finally {
    client.release();
  }
};

/**
 * Reject a task - matching message-backend
 */
export const rejectTask = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id } = req.params;
    const { reason } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!reason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    // Check if user is assigned to this task
    const assigneeCheck = await client.query(
      `SELECT * FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (assigneeCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You are not assigned to this task' });
    }

    // Get conversation first (before removing user)
    const conversationResult = await client.query(
      `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
      [id]
    );

    // Remove the user from task assignees entirely so the task is no longer visible to them
    await client.query(
      `DELETE FROM task_assignees 
       WHERE task_id = $1 AND user_id = $2`,
      [id, userId]
    );

    // Note: task_assignees table doesn't have rejected_at or rejection_reason columns
    // Rejection is tracked via task_activities log and by removing the assignee record

    await logTaskActivity(client, {
      taskId: id,
      userId,
      activityType: 'rejected',
      message: `Task rejected: ${reason}`,
    });

    // Post rejection message to task group chat (before removing user)
    if (conversationResult.rows.length > 0) {
      // Check if user is still a member (they might not have accepted yet)
      const memberCheck = await client.query(
        `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
        [conversationResult.rows[0].id, userId]
      );

      if (memberCheck.rows.length > 0) {
        // User is a member, post message
        await client.query(
          `INSERT INTO messages (conversation_id, sender_id, content, message_type)
           VALUES ($1, $2, $3, 'text')`,
          [conversationResult.rows[0].id, userId, `Task rejected. Reason: ${reason}`]
        );

        // Remove user from task group conversation after posting message
        await client.query(
          `DELETE FROM conversation_members 
           WHERE conversation_id = $1 AND user_id = $2`,
          [conversationResult.rows[0].id, userId]
        );
      } else {
        // User was never a member (never accepted), admin will see rejection in task details
        // No need to post message or remove from conversation
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Task rejected successfully' });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Reject task error:', error);
    res.status(500).json({ error: 'Failed to reject task' });
  } finally {
    client.release();
  }
};

/**
 * Update task status - matching message-backend
 */
export const updateTaskStatus = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;
    const { status } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Validate status
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    if (!['todo', 'active', 'in_progress', 'pending_verification', 'completed', 'rejected', 'deleted', 'pending'].includes(status)) {
      return res.status(400).json({ error: `Invalid status: ${status}` });
    }

    // First check if task exists
    const activeById = await getTasksActiveByIdClause();
    const taskCheck = await query(
      `SELECT 
        id,
        COALESCE(created_by, creator_id) as creator_id,
        status,
        EXISTS (SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2) as is_assignee,
        EXISTS (SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2 AND role = 'creator') as is_creator_role
       FROM tasks 
       WHERE id = $1${activeById}`,
      [id, userId]
    );

    if (taskCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskCheck.rows[0];
    const isCreator = task.is_creator_role === true || task.creator_id === userId;
    const isAssignee = task.is_assignee;

    if (!isCreator && !isAssignee) {
      return res.status(403).json({ 
        error: 'You do not have permission to update this task. You must be the creator or an assignee.' 
      });
    }

    if (!isValidTransition(task.status, status)) {
      return res.status(422).json({
        error: `Invalid status transition from ${task.status} to ${status}`,
      });
    }

    const result = await query(
      `UPDATE tasks 
       SET status = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Failed to update task' });
    }

    // When setting task to in_progress, also set current user's task_assignees row to inprogress (and accepted_at if not set)
    // so dashboard "In Progress" click keeps assignee status in sync with task status
    if (status === 'in_progress') {
      await query(
        `UPDATE task_assignees 
         SET accepted_at = COALESCE(accepted_at, CURRENT_TIMESTAMP),
             status = 'inprogress'
         WHERE task_id = $1 AND user_id = $2`,
        [id, userId]
      );
    }

    // Log activity (don't fail if activity log fails)
    try {
      await query(
        `INSERT INTO task_activities (task_id, user_id, activity_type, new_value, message)
         VALUES ($1, $2, 'status_changed', $3, $4)`,
        [id, userId, status, `Task status changed to ${status}`]
      );
    } catch (activityError: any) {
      console.error('Failed to log activity (non-critical):', activityError);
      // Continue even if activity logging fails
    }

    const io = (req.app as any).get('io');
    io?.to(`task_${id}`).emit('task:status_changed', {
      taskId: id,
      fromStatus: task.status,
      toStatus: status,
      computedAt: new Date().toISOString(),
    });

    const taskAssignees = await query(`SELECT user_id FROM task_assignees WHERE task_id = $1`, [id]);
    await dispatchNotification({
      type: 'TASK_STATUS_CHANGED',
      recipientIds: taskAssignees.rows.map((r: any) => r.user_id),
      title: 'Task status updated',
      body: `Task moved to ${status}`,
      refId: id,
      refType: 'task',
      io,
    });

    res.json({ task: buildTaskWithDerivedStatus(result.rows[0]) });
  } catch (error: any) {
    console.error('Update task status error:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      userId: req.user?.userId,
      taskId: req.params?.id,
      status: req.body?.status
    });
    res.status(500).json({ 
      error: 'Failed to update task status',
      message: error.message || 'Unknown error occurred'
    });
  }
};

/**
 * Update task - matching message-backend
 */
export const updateTask = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;
    const updates = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const organizationId = await resolveOrganizationIdForUser(userId, req.user?.organizationId || null);
    let orgStructureReference:
      | {
          nodeId: string;
          levelKey: string;
          path: Array<{
            id: string;
            name: string;
            code: string;
            levelNumber: number;
            levelKey: string;
            levelLabel: string;
            status: 'active' | 'inactive' | 'archived';
          }>;
          pathDisplay: string;
        }
      | null
      | undefined = undefined;

    if (updates.org_structure_node_id !== undefined) {
      if (updates.org_structure_node_id) {
        if (!organizationId) {
          return res.status(400).json({ error: 'Organization context is required for org structure updates' });
        }

        orgStructureReference = await resolveNodeReference(organizationId, String(updates.org_structure_node_id), {
          activeOnly: true,
        });
      } else {
        orgStructureReference = null;
      }
    }

    const columnCheck = await query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'tasks'
         AND column_name IN ('org_structure_node_id', 'org_structure_level_key', 'org_structure_path')`
    );
    const hasOrgStructureNodeId = columnCheck.rows.some((row: any) => row.column_name === 'org_structure_node_id');
    const hasOrgStructureLevelKey = columnCheck.rows.some((row: any) => row.column_name === 'org_structure_level_key');
    const hasOrgStructurePath = columnCheck.rows.some((row: any) => row.column_name === 'org_structure_path');

    // Build dynamic update query
    const allowedFields = [
      'title',
      'description',
      'client_name',
      'start_date',
      'target_date',
      'due_date',
    ];
    const updateFields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        updateFields.push(`${field} = $${paramIndex}`);
        values.push(updates[field]);
        paramIndex++;
      }
    }

    if (updates.org_structure_node_id !== undefined) {
      if (hasOrgStructureNodeId) {
        updateFields.push(`org_structure_node_id = $${paramIndex}`);
        values.push(orgStructureReference?.nodeId || null);
        paramIndex++;
      }

      if (hasOrgStructureLevelKey) {
        updateFields.push(`org_structure_level_key = $${paramIndex}`);
        values.push(orgStructureReference?.levelKey || null);
        paramIndex++;
      }

      if (hasOrgStructurePath) {
        updateFields.push(`org_structure_path = $${paramIndex}`);
        values.push(orgStructureReference?.path ? JSON.stringify(orgStructureReference.path) : null);
        paramIndex++;
      }
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(id, userId);
    const result = await query(
      `UPDATE tasks 
       SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${paramIndex} AND COALESCE(created_by, creator_id) = $${paramIndex + 1}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found or unauthorized' });
    }

    res.json({
      task: buildTaskWithDerivedStatus(result.rows[0]),
    });
  } catch (error: any) {
    console.error('Update task error:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
};

/**
 * Delete a task (creator or admin)
 */
export const deleteTask = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const userRole = req.user?.role;
    const userOrgId = req.user?.organizationId;
    const { id } = req.params;

    if (!userId) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const taskResult = await client.query(
      `SELECT 
         id,
         organization_id,
         COALESCE(created_by, creator_id) as creator_id,
         EXISTS (
           SELECT 1 FROM task_assignees ta_c
           WHERE ta_c.task_id = tasks.id AND ta_c.user_id = $2 AND ta_c.role = 'creator'
         ) as is_creator_role,
         title
       FROM tasks
       WHERE id = $1`,
      [id, userId]
    );

    if (taskResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];
    const isCreator = task.is_creator_role === true || task.creator_id === userId;
    const isAdmin = userRole === 'admin' || userRole === 'super_admin';

    if (!isCreator && !isAdmin) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Admins can only delete tasks within their organization (super_admin can delete any)
    if (userRole === 'admin' && userOrgId && task.organization_id && task.organization_id !== userOrgId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Collect recipients before hard delete removes assignment rows.
    const assigneesResult = await client.query(
      `SELECT user_id FROM task_assignees WHERE task_id = $1`,
      [id]
    );

    await logTaskActivity(client, {
      taskId: id,
      userId,
      activityType: 'task_deleted',
      message: `Task "${task.title}" deleted`,
    });

    await hardDeleteTaskAndRelations(client, id);

    await client.query('COMMIT');
    const io = (req.app as any).get('io');
    await dispatchNotification({
      type: 'TASK_DELETED',
      recipientIds: assigneesResult.rows.map((r: any) => r.user_id),
      title: 'Task deleted',
      body: `Task "${task.title}" was deleted.`,
      refId: id,
      refType: 'task',
      io,
    });
    res.json({ success: true, message: 'Task deleted' });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Delete task error:', error);
    res.status(500).json({ error: 'Failed to delete task' });
  } finally {
    client.release();
  }
};

/**
 * Mark member task as complete (user marks their own completion)
 */
export const completeTaskForVerification = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id: taskId } = req.params;

    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const activeById = await getTasksActiveByIdClause();
    const taskResult = await client.query(
      `SELECT id, title, COALESCE(created_by, creator_id) as owner_id, status
       FROM tasks
       WHERE id = $1${activeById}`,
      [taskId]
    );
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });

    const task = taskResult.rows[0];
    const assigneeCheck = await client.query(
      `SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
      [taskId, userId]
    );
    if (assigneeCheck.rows.length === 0) return res.status(403).json({ error: 'You are not assigned to this task' });

    if (!isValidTransition(task.status, 'pending_verification')) {
      return res.status(422).json({ error: `Invalid status transition from ${task.status} to pending_verification` });
    }

    const updateTask = await client.query(
      `UPDATE tasks
       SET status = 'pending_verification',
           verification_status = 'pending',
           completed_by_assignee_at = CURRENT_TIMESTAMP,
           verified_by_owner_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [taskId]
    );

    await client.query(
      `UPDATE task_assignees
       SET completed_at = CURRENT_TIMESTAMP,
           verified_at = NULL,
           status = 'completed'
       WHERE task_id = $1 AND user_id = $2`,
      [taskId, userId]
    );

    await logTaskActivity(client, {
      taskId,
      userId,
      activityType: 'completion_pending',
      message: 'Task marked complete and moved to pending verification',
    });

    await client.query('COMMIT');
    const io = (req.app as any).get('io');
    await dispatchNotification({
      type: 'TASK_COMPLETE_PENDING',
      recipientIds: [task.owner_id],
      title: 'Task awaiting verification',
      body: `${task.title} was marked complete and needs your verification.`,
      refId: taskId,
      refType: 'task',
      io,
    });
    io?.to(`task_${taskId}`).emit('task:status_changed', {
      taskId,
      fromStatus: task.status,
      toStatus: 'pending_verification',
      computedAt: new Date().toISOString(),
    });

    res.json({ task: buildTaskWithDerivedStatus(updateTask.rows[0]), notification_sent: true });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Complete task error:', error);
    res.status(500).json({ error: 'Failed to mark task complete' });
  } finally {
    client.release();
  }
};

export const verifyTaskCompletion = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id: taskId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const activeById = await getTasksActiveByIdClause();
    const taskResult = await client.query(
      `SELECT id, title, status, COALESCE(created_by, creator_id) as owner_id
       FROM tasks WHERE id = $1${activeById}`,
      [taskId]
    );
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    const task = taskResult.rows[0];

    if (String(task.owner_id) !== String(userId)) {
      return res.status(403).json({ error: 'Only task owner can verify completion' });
    }
    if (!isValidTransition(task.status, 'completed')) {
      return res.status(422).json({ error: `Invalid status transition from ${task.status} to completed` });
    }

    const updatedTask = await client.query(
      `UPDATE tasks
       SET status = 'completed',
           verification_status = 'verified',
           verified_by_owner_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [taskId]
    );

    await client.query(
      `UPDATE task_assignees
       SET verified_at = CURRENT_TIMESTAMP,
           status = 'completed'
       WHERE task_id = $1 AND completed_at IS NOT NULL`,
      [taskId]
    );

    await logTaskActivity(client, {
      taskId,
      userId,
      activityType: 'completion_verified',
      message: 'Owner verified task completion',
    });

    const recipientsResult = await client.query(
      `SELECT user_id FROM task_assignees WHERE task_id = $1`,
      [taskId]
    );
    await client.query('COMMIT');
    const io = (req.app as any).get('io');
    await dispatchNotification({
      type: 'TASK_VERIFIED',
      recipientIds: recipientsResult.rows.map((r: any) => r.user_id),
      title: 'Task verified',
      body: `${task.title} was verified by the owner.`,
      refId: taskId,
      refType: 'task',
      io,
    });

    io?.to(`task_${taskId}`).emit('task:status_changed', {
      taskId,
      fromStatus: task.status,
      toStatus: 'completed',
      computedAt: new Date().toISOString(),
    });

    res.json({ task: buildTaskWithDerivedStatus(updatedTask.rows[0]) });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Verify task completion error:', error);
    res.status(500).json({ error: 'Failed to verify task completion' });
  } finally {
    client.release();
  }
};

/**
 * Task owner marks the whole task completed: all assignees get completed + verified rows and task.status = completed.
 * Allowed from any non-terminal task status (does not require assignees to have completed individually).
 */
export const ownerCompleteTask = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    const userId = req.user?.userId;
    const { id: taskId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const activeById = await getTasksActiveByIdClause();
    const taskResult = await client.query(
      `SELECT t.id,
              t.title,
              t.status,
              COALESCE(t.created_by, t.creator_id) AS owner_id
       FROM tasks t
       WHERE t.id = $1${activeById}`,
      [taskId]
    );
    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];
    const roleCreatorResult = await client.query(
      `SELECT 1 FROM task_assignees
       WHERE task_id = $1 AND user_id = $2 AND role = 'creator'
       LIMIT 1`,
      [taskId, userId]
    );
    const ownerIdMatches =
      task.owner_id != null && String(task.owner_id) === String(userId);
    const isOwner =
      ownerIdMatches || roleCreatorResult.rows.length > 0;

    if (!isOwner) {
      return res.status(403).json({
        error: 'Only the task owner can complete the task for everyone',
      });
    }

    const statusLower = String(task.status || '').toLowerCase();
    if (statusLower === 'completed') {
      const fresh = await client.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
      return res.json({
        task: buildTaskWithDerivedStatus(fresh.rows[0]),
        taskCompleted: true,
        already_completed: true,
      });
    }

    if (statusLower === 'deleted' || statusLower === 'rejected') {
      return res.status(422).json({
        error: `Cannot complete task in status ${task.status}`,
      });
    }

    await client.query('BEGIN');

    await client.query(
      `UPDATE task_assignees
       SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
           verified_at = CURRENT_TIMESTAMP,
           status = 'completed'
       WHERE task_id = $1`,
      [taskId]
    );

    const updatedTask = await client.query(
      `UPDATE tasks
       SET status = 'completed',
           verification_status = 'verified',
           verified_by_owner_at = CURRENT_TIMESTAMP,
           completed_by_assignee_at = COALESCE(completed_by_assignee_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [taskId]
    );

    await logTaskActivity(client, {
      taskId,
      userId,
      activityType: 'task_overridden',
      message: 'Owner completed the task for all members',
    });

    const recipientsResult = await client.query(
      `SELECT user_id FROM task_assignees WHERE task_id = $1`,
      [taskId]
    );

    await client.query('COMMIT');

    const io = (req.app as any).get('io');
    await dispatchNotification({
      type: 'TASK_VERIFIED',
      recipientIds: recipientsResult.rows.map((r: any) => r.user_id),
      title: 'Task completed',
      body: `${task.title} was marked completed by the owner.`,
      refId: taskId,
      refType: 'task',
      io,
    });

    io?.to(`task_${taskId}`).emit('task:status_changed', {
      taskId,
      fromStatus: task.status,
      toStatus: 'completed',
      computedAt: new Date().toISOString(),
    });

    res.json({
      task: buildTaskWithDerivedStatus(updatedTask.rows[0]),
      taskCompleted: true,
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Owner complete task error:', error);
    res.status(500).json({ error: 'Failed to complete task' });
  } finally {
    client.release();
  }
};

export const rejectTaskCompletion = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id: taskId } = req.params;
    const reason = String(req.body?.reason || '').trim();
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (reason.length < 10) {
      return res.status(400).json({ error: 'Reason is required and must be at least 10 characters' });
    }

    const activeById = await getTasksActiveByIdClause();
    const taskResult = await client.query(
      `SELECT id, title, status, COALESCE(created_by, creator_id) as owner_id
       FROM tasks WHERE id = $1${activeById}`,
      [taskId]
    );
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    const task = taskResult.rows[0];
    if (String(task.owner_id) !== String(userId)) {
      return res.status(403).json({ error: 'Only task owner can reject completion' });
    }
    if (!isValidTransition(task.status, 'in_progress')) {
      return res.status(422).json({ error: `Invalid status transition from ${task.status} to in_progress` });
    }

    const updatedTask = await client.query(
      `UPDATE tasks
       SET status = 'in_progress',
           verification_status = 'rejected',
           completed_by_assignee_at = NULL,
           verified_by_owner_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [taskId]
    );

    await client.query(
      `UPDATE task_assignees
       SET completed_at = NULL,
           verified_at = NULL,
           status = 'inprogress'
       WHERE task_id = $1`,
      [taskId]
    );

    await logTaskActivity(client, {
      taskId,
      userId,
      activityType: 'task_reassigned',
      message: `Completion rejected: ${reason}`,
    });

    const recipientsResult = await client.query(
      `SELECT user_id FROM task_assignees WHERE task_id = $1`,
      [taskId]
    );

    await client.query('COMMIT');
    const io = (req.app as any).get('io');
    await dispatchNotification({
      type: 'TASK_COMPLETION_REJECTED',
      recipientIds: recipientsResult.rows.map((r: any) => r.user_id),
      title: 'Completion rejected',
      body: reason,
      refId: taskId,
      refType: 'task',
      io,
    });

    io?.to(`task_${taskId}`).emit('task:status_changed', {
      taskId,
      fromStatus: task.status,
      toStatus: 'in_progress',
      computedAt: new Date().toISOString(),
    });

    res.json({ task: buildTaskWithDerivedStatus(updatedTask.rows[0]) });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Reject task completion error:', error);
    res.status(500).json({ error: 'Failed to reject completion' });
  } finally {
    client.release();
  }
};

export const requestTaskDelete = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id: taskId } = req.params;
    const reason = String(req.body?.reason || '').trim();
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!reason) return res.status(400).json({ error: 'Reason is required' });

    const activeById = await getTasksActiveByIdClause();
    const taskResult = await client.query(
      `SELECT id, title, COALESCE(created_by, creator_id) as owner_id
       FROM tasks WHERE id = $1${activeById}`,
      [taskId]
    );
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    const task = taskResult.rows[0];

    if (String(task.owner_id) === String(userId)) {
      return res.status(400).json({ error: 'Owner can delete directly; request is not required' });
    }

    const deleteRequestsTable = await getTaskDeleteRequestsTableExists();
    let persistedRequest: any = null;
    if (deleteRequestsTable) {
      const requestResult = await client.query(
        `INSERT INTO task_delete_requests (task_id, requested_by, reason, status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING *`,
        [taskId, userId, reason]
      );
      persistedRequest = requestResult.rows[0];
    }

    const conversationResult = await client.query(
      `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
      [taskId]
    );
    if (conversationResult.rows.length > 0) {
      await insertSystemMessageOptionalMetadata(client, {
        conversationId: conversationResult.rows[0].id,
        senderId: userId,
        content: `A member asked to delete this task: ${reason}`,
        metadata: {
          requestType: 'task_delete',
          requestId: persistedRequest?.id ?? null,
          actionChips: ['approve', 'reject'],
        },
      });
    }

    await logTaskActivity(client, {
      taskId,
      userId,
      activityType: 'delete_request_created',
      message: `Delete requested: ${reason}`,
    });

    await client.query('COMMIT');
    const io = (req.app as any).get('io');
    await dispatchNotification({
      type: 'DELETE_REQUEST_RECEIVED',
      recipientIds: [task.owner_id],
      title: 'Task delete request',
      body: `${reason}`,
      refId: taskId,
      refType: 'task',
      io,
    });
    res.json({
      success: true,
      request: persistedRequest,
      deleteRequestsPersisted: deleteRequestsTable,
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Request task delete error:', error);
    res.status(500).json({ error: 'Failed to request delete' });
  } finally {
    client.release();
  }
};

export const approveTaskDeleteRequest = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id: taskId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const activeById = await getTasksActiveByIdClause();
    const taskResult = await client.query(
      `SELECT id, title, COALESCE(created_by, creator_id) as owner_id
       FROM tasks WHERE id = $1${activeById}`,
      [taskId]
    );
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    const task = taskResult.rows[0];
    if (String(task.owner_id) !== String(userId)) {
      return res.status(403).json({ error: 'Only owner can approve delete requests' });
    }

    const deleteRequestsTable = await getTaskDeleteRequestsTableExists();
    let request: { id: string; requested_by?: string } | null = null;
    if (deleteRequestsTable) {
      const reqResult = await client.query(
        `SELECT * FROM task_delete_requests
         WHERE task_id = $1 AND status = 'pending'
         ORDER BY created_at DESC
         LIMIT 1`,
        [taskId]
      );
      if (reqResult.rows.length === 0) return res.status(404).json({ error: 'No pending delete request found' });
      request = reqResult.rows[0];

      await client.query(
        `UPDATE task_delete_requests
         SET status = 'approved', decided_by = $2, decided_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [request.id, userId]
      );
    }

    await hardDeleteTaskAndRelations(client, taskId);

    await logTaskActivity(client, {
      taskId,
      userId,
      activityType: 'task_deleted',
      message: 'Delete request approved and task hard-deleted',
    });

    const convApprove = await client.query(
      `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
      [taskId]
    );
    if (convApprove.rows.length > 0) {
      await resolveSystemRequestActionChips(client, {
        conversationId: convApprove.rows[0].id,
        requestType: 'task_delete',
        requestId: request?.id || null,
        decision: 'approved',
      });
      await insertSystemMessageOptionalMetadata(client, {
        conversationId: convApprove.rows[0].id,
        senderId: userId,
        content: 'The task owner approved deleting this task. The task has been removed.',
        metadata: { requestType: 'task_delete_decision', decision: 'approved' },
      });
    }

    await client.query('COMMIT');
    const io = (req.app as any).get('io');
    const notifyRequester = request?.requested_by ? [request.requested_by] : [];
    if (notifyRequester.length > 0) {
      await dispatchNotification({
        type: 'TASK_DELETED',
        recipientIds: notifyRequester,
        title: 'Delete request approved',
        body: `${task.title} has been deleted.`,
        refId: taskId,
        refType: 'task',
        io,
      });
    }
    res.json({ success: true, deleteRequestsPersisted: deleteRequestsTable });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Approve task delete request error:', error);
    res.status(500).json({ error: 'Failed to approve delete request' });
  } finally {
    client.release();
  }
};

export const denyTaskDeleteRequest = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id: taskId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const activeByIdDeny = await getTasksActiveByIdClause();
    const taskResult = await client.query(
      `SELECT id, title, COALESCE(created_by, creator_id) as owner_id
       FROM tasks WHERE id = $1${activeByIdDeny}`,
      [taskId]
    );
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    const task = taskResult.rows[0];
    if (String(task.owner_id) !== String(userId)) {
      return res.status(403).json({ error: 'Only owner can deny delete requests' });
    }

    const deleteRequestsTableDeny = await getTaskDeleteRequestsTableExists();
    let request: { id: string; requested_by?: string } | null = null;
    if (deleteRequestsTableDeny) {
      const reqResult = await client.query(
        `SELECT * FROM task_delete_requests
         WHERE task_id = $1 AND status = 'pending'
         ORDER BY created_at DESC
         LIMIT 1`,
        [taskId]
      );
      if (reqResult.rows.length === 0) return res.status(404).json({ error: 'No pending delete request found' });
      request = reqResult.rows[0];

      await client.query(
        `UPDATE task_delete_requests
         SET status = 'denied', decided_by = $2, decided_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [request.id, userId]
      );
    }

    await logTaskActivity(client, {
      taskId,
      userId,
      activityType: 'delete_request_denied',
      message: 'Delete request denied',
    });

    const convDeny = await client.query(
      `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
      [taskId]
    );
    if (convDeny.rows.length > 0) {
      await resolveSystemRequestActionChips(client, {
        conversationId: convDeny.rows[0].id,
        requestType: 'task_delete',
        requestId: request?.id || null,
        decision: 'denied',
      });
      await insertSystemMessageOptionalMetadata(client, {
        conversationId: convDeny.rows[0].id,
        senderId: userId,
        content: 'The task owner declined the request to delete this task.',
        metadata: { requestType: 'task_delete_decision', decision: 'denied' },
      });
    }

    await client.query('COMMIT');
    const io = (req.app as any).get('io');
    if (request?.requested_by) {
      await dispatchNotification({
        type: 'DELETE_REQUEST_RECEIVED',
        recipientIds: [request.requested_by],
        title: 'Delete request denied',
        body: `${task.title} delete request was denied.`,
        refId: taskId,
        refType: 'task',
        io,
      });
    }
    res.json({ success: true, deleteRequestsPersisted: deleteRequestsTableDeny });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Deny task delete request error:', error);
    res.status(500).json({ error: 'Failed to deny delete request' });
  } finally {
    client.release();
  }
};

export const createExitRequest = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id: taskId } = req.params;
    const comment = String(req.body?.comment || '').trim();
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (!comment) return res.status(400).json({ error: 'Comment is required' });

    const activeByIdExit = await getTasksActiveByIdClause();
    const taskResult = await client.query(
      `SELECT id, title, COALESCE(created_by, creator_id) as owner_id
       FROM tasks WHERE id = $1${activeByIdExit}`,
      [taskId]
    );
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    const task = taskResult.rows[0];

    const assigneeCheck = await client.query(
      `SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
      [taskId, userId]
    );
    if (assigneeCheck.rows.length === 0) return res.status(403).json({ error: 'Only assignees can request exit' });

    const requestResult = await client.query(
      `INSERT INTO task_exit_requests (task_id, assignee_id, comment, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [taskId, userId, comment]
    );

    const requesterResult = await client.query(
      `SELECT name FROM users WHERE id = $1`,
      [userId]
    );
    const requesterName = requesterResult.rows[0]?.name || 'User';

    const conversationResult = await client.query(
      `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
      [taskId]
    );
    if (conversationResult.rows.length > 0) {
      const taskConversationId = conversationResult.rows[0].id;
      await insertSystemMessageOptionalMetadata(client, {
        conversationId: taskConversationId,
        senderId: userId,
        content: `${requesterName} requested task exit`,
        metadata: {
          requestType: 'task_exit',
          requestId: requestResult.rows[0].id,
          actionChips: ['approve', 'reject'],
        },
      });

      // Keep user's comment as a regular chat bubble below the centered system request.
      await client.query(
        `INSERT INTO messages (conversation_id, sender_id, content, message_type)
         VALUES ($1, $2, $3, 'text')`,
        [taskConversationId, userId, comment]
      );
    }

    await logTaskActivity(client, {
      taskId,
      userId,
      activityType: 'exit_requested',
      message: `Exit requested: ${comment}`,
    });

    await client.query('COMMIT');
    const io = (req.app as any).get('io');
    await dispatchNotification({
      type: 'EXIT_REQUEST_RECEIVED',
      recipientIds: [task.owner_id],
      title: 'Task exit request',
      body: comment,
      refId: taskId,
      refType: 'task',
      io,
    });
    res.json({ success: true, request: requestResult.rows[0] });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Create exit request error:', error);
    res.status(500).json({ error: 'Failed to request exit' });
  } finally {
    client.release();
  }
};

export const approveExitRequest = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id: taskId, requestId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const activeByIdApproveExit = await getTasksActiveByIdClause();
    const taskResult = await client.query(
      `SELECT id, title, COALESCE(created_by, creator_id) as owner_id
       FROM tasks WHERE id = $1${activeByIdApproveExit}`,
      [taskId]
    );
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    const task = taskResult.rows[0];
    if (String(task.owner_id) !== String(userId)) {
      return res.status(403).json({ error: 'Only owner can approve exit request' });
    }

    const reqResult = await client.query(
      `SELECT * FROM task_exit_requests
       WHERE id = $1 AND task_id = $2 AND status = 'pending'`,
      [requestId, taskId]
    );
    if (reqResult.rows.length === 0) return res.status(404).json({ error: 'Exit request not found' });
    const request = reqResult.rows[0];

    await client.query(
      `UPDATE task_exit_requests
       SET status = 'approved', decided_by = $2, decided_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [requestId, userId]
    );
    // Some environments still enforce older task_assignees status constraints
    // that do not include 'exited'. Remove assignee row to mark task exit.
    await client.query(
      `DELETE FROM task_assignees
       WHERE task_id = $1 AND user_id = $2`,
      [taskId, request.assignee_id]
    );

    await logTaskActivity(client, {
      taskId,
      userId,
      activityType: 'exit_approved',
      message: 'Exit request approved',
    });

    const assigneeResult = await client.query(
      `SELECT name FROM users WHERE id = $1`,
      [request.assignee_id]
    );
    const assigneeName = assigneeResult.rows[0]?.name || 'Member';
    const convApproveExit = await client.query(
      `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
      [taskId]
    );
    if (convApproveExit.rows.length > 0) {
      await resolveSystemRequestActionChips(client, {
        conversationId: convApproveExit.rows[0].id,
        requestType: 'task_exit',
        requestId,
        decision: 'approved',
      });
      await insertSystemMessageOptionalMetadata(client, {
        conversationId: convApproveExit.rows[0].id,
        senderId: userId,
        content: `${assigneeName} exited this task group.`,
        metadata: { requestType: 'task_exit_decision', requestId, decision: 'approved' },
      });
    }

    await client.query('COMMIT');
    const io = (req.app as any).get('io');
    await dispatchNotification({
      type: 'EXIT_APPROVED',
      recipientIds: [request.assignee_id],
      title: 'Exit approved',
      body: `You have been released from ${task.title}.`,
      refId: taskId,
      refType: 'task',
      io,
    });
    res.json({ success: true });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Approve exit request error:', error);
    res.status(500).json({ error: 'Failed to approve exit request' });
  } finally {
    client.release();
  }
};

export const rejectExitRequest = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id: taskId, requestId } = req.params;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const activeByIdRejectExit = await getTasksActiveByIdClause();
    const taskResult = await client.query(
      `SELECT id, title, COALESCE(created_by, creator_id) as owner_id
       FROM tasks WHERE id = $1${activeByIdRejectExit}`,
      [taskId]
    );
    if (taskResult.rows.length === 0) return res.status(404).json({ error: 'Task not found' });
    const task = taskResult.rows[0];
    if (String(task.owner_id) !== String(userId)) {
      return res.status(403).json({ error: 'Only owner can reject exit request' });
    }

    const reqResult = await client.query(
      `SELECT * FROM task_exit_requests
       WHERE id = $1 AND task_id = $2 AND status = 'pending'`,
      [requestId, taskId]
    );
    if (reqResult.rows.length === 0) return res.status(404).json({ error: 'Exit request not found' });
    const request = reqResult.rows[0];

    await client.query(
      `UPDATE task_exit_requests
       SET status = 'rejected', decided_by = $2, decided_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [requestId, userId]
    );

    await logTaskActivity(client, {
      taskId,
      userId,
      activityType: 'exit_rejected',
      message: 'Exit request rejected',
    });

    const assigneeResult = await client.query(
      `SELECT name FROM users WHERE id = $1`,
      [request.assignee_id]
    );
    const assigneeName = assigneeResult.rows[0]?.name || 'Member';
    const convRejectExit = await client.query(
      `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
      [taskId]
    );
    if (convRejectExit.rows.length > 0) {
      await resolveSystemRequestActionChips(client, {
        conversationId: convRejectExit.rows[0].id,
        requestType: 'task_exit',
        requestId,
        decision: 'rejected',
      });
      await insertSystemMessageOptionalMetadata(client, {
        conversationId: convRejectExit.rows[0].id,
        senderId: userId,
        content: `Exit request from ${assigneeName} was rejected.`,
        metadata: { requestType: 'task_exit_decision', requestId, decision: 'rejected' },
      });
    }

    await client.query('COMMIT');
    const io = (req.app as any).get('io');
    await dispatchNotification({
      type: 'EXIT_REJECTED',
      recipientIds: [request.assignee_id],
      title: 'Exit rejected',
      body: `Exit request for ${task.title} was rejected.`,
      refId: taskId,
      refType: 'task',
      io,
    });
    res.json({ success: true });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Reject exit request error:', error);
    res.status(500).json({ error: 'Failed to reject exit request' });
  } finally {
    client.release();
  }
};

/**
 * Mark member task as complete (user marks their own completion)
 */
export const markMemberComplete = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id: taskId, userId: targetUserId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // User can only mark their own completion
    if (userId !== targetUserId) {
      return res.status(403).json({ error: 'You can only mark your own task as complete' });
    }

    // Check if user is assigned to this task
    const assigneeCheck = await client.query(
      `SELECT * FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
      [taskId, userId]
    );

    if (assigneeCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You are not assigned to this task' });
    }

    // Check if user is the task creator (source of truth: task_assignees.role, fallback to tasks table)
    const taskCheck = await client.query(
      `SELECT 
        COALESCE(t.created_by, t.creator_id) as creator_id,
        EXISTS (
          SELECT 1 FROM task_assignees ta_c 
          WHERE ta_c.task_id = t.id AND ta_c.user_id = $2 AND ta_c.role = 'creator'
        ) as is_creator_role
       FROM tasks t
       WHERE t.id = $1`,
      [taskId, userId]
    );

    if (taskCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const isCreator = taskCheck.rows[0].is_creator_role === true || taskCheck.rows[0].creator_id === userId;

    // No separate acceptance step: assigned users can complete directly.
    // Check if already completed
    if (assigneeCheck.rows[0].completed_at) {
      return res.status(400).json({ error: 'You have already marked this task as complete' });
    }

    // Get user name for activity log
    const userResult = await client.query(
      `SELECT name FROM users WHERE id = $1`,
      [userId]
    );
    const userName = userResult.rows[0]?.name || 'User';

    if (isCreator) {
      // If creator completes their task, mark the entire task (and all members) as completed.
      // 1) Ensure every assignee (including creator) is marked completed + verified for this task.
      await client.query(
        `UPDATE task_assignees
         SET completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
             verified_at = CURRENT_TIMESTAMP,
             status = 'completed'
         WHERE task_id = $1`,
        [taskId]
      );

      // 2) Mark the task row as completed.
      await client.query(
        `UPDATE tasks SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [taskId]
      );

      // Log activity
      await logTaskActivity(client, {
        taskId,
        userId,
        activityType: 'task_overridden',
        message: `Creator (${userName}) completed the task - Task marked as completed`,
      });

      await client.query('COMMIT');
      res.json({ message: 'Task completed. The entire task has been marked as completed.', taskCompleted: true });
    } else {
      // Regular assignee - mark as complete (pending verification)
      await client.query(
        `UPDATE task_assignees 
         SET completed_at = CURRENT_TIMESTAMP, verified_at = NULL, status = 'completed'
         WHERE task_id = $1 AND user_id = $2`,
        [taskId, userId]
      );

      // Log activity
      await logTaskActivity(client, {
        taskId,
        userId,
        activityType: 'completion_pending',
        message: `${userName} marked their task as complete - Pending verification`,
      });

      await client.query('COMMIT');
      res.json({ message: 'Task marked as complete. Waiting for verification.' });
    }
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Mark complete error:', error);
    res.status(500).json({ error: 'Failed to mark task as complete' });
  } finally {
    client.release();
  }
};

/**
 * Verify member completion (creator verifies member's completion)
 */
export const verifyMemberCompletion = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id: taskId, userId: targetUserId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check if current user is the task creator or reporting member
    // Source of truth: task_assignees.role; fallback: tasks columns for backward compatibility
    const taskCheck = await client.query(
      `SELECT 
        COALESCE(t.created_by, t.creator_id) as legacy_creator_id,
        t.reporting_member_id as legacy_reporting_member_id,
        (SELECT ta_c.user_id FROM task_assignees ta_c WHERE ta_c.task_id = t.id AND ta_c.role = 'creator' LIMIT 1) as role_creator_id,
        (SELECT ta_r.user_id FROM task_assignees ta_r WHERE ta_r.task_id = t.id AND ta_r.role = 'reporting_member' LIMIT 1) as role_reporting_member_id
      FROM tasks t 
      WHERE t.id = $1`,
      [taskId]
    );

    if (taskCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskCheck.rows[0];
    const creatorId = (task.role_creator_id || task.legacy_creator_id) as string | null;
    const reportingMemberId = (task.role_reporting_member_id || task.legacy_reporting_member_id) as string | null;
    const isCreator = !!creatorId && String(creatorId) === String(userId);
    const isReportingMember = !!reportingMemberId && String(reportingMemberId) === String(userId);

    if (!isCreator && !isReportingMember) {
      return res.status(403).json({ 
        error: 'Only the task creator or reporting member can verify completions' 
      });
    }

    // Check if target user is assigned and has marked as complete
    const assigneeCheck = await client.query(
      `SELECT * FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
      [taskId, targetUserId]
    );

    if (assigneeCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User is not assigned to this task' });
    }

    if (!assigneeCheck.rows[0].completed_at) {
      return res.status(400).json({ error: 'User has not marked their task as complete yet' });
    }

    if (assigneeCheck.rows[0].verified_at) {
      return res.status(400).json({ error: 'Completion has already been verified' });
    }

    // Verify permissions: Reporting member can only verify non-reporting assignees
    // Creator can verify reporting member or all assignees if no reporting member
    if (isReportingMember) {
      // Reporting member cannot verify themselves
      if (targetUserId === userId) {
        return res.status(403).json({ 
          error: 'Reporting member cannot verify their own completion. Creator must verify it.' 
        });
      }
      // Reporting member cannot verify the creator
      if (creatorId && String(targetUserId) === String(creatorId)) {
        return res.status(403).json({ 
          error: 'Reporting member cannot verify creator\'s completion' 
        });
      }
    } else if (isCreator) {
      // Creator can verify reporting member or any assignee if no reporting member
      if (reportingMemberId && String(targetUserId) !== String(reportingMemberId)) {
        // If there's a reporting member, creator should only verify the reporting member
        // Regular assignees should be verified by reporting member
        const isTargetReportingMember = String(targetUserId) === String(reportingMemberId);
        if (!isTargetReportingMember) {
          return res.status(403).json({ 
            error: 'Creator can only verify reporting member. Regular assignees should be verified by reporting member.' 
          });
        }
      }
    }

    // Verify the completion
    await client.query(
      `UPDATE task_assignees 
       SET verified_at = CURRENT_TIMESTAMP
       WHERE task_id = $1 AND user_id = $2`,
      [taskId, targetUserId]
    );

    // Get user name for activity log
    const userResult = await client.query(
      `SELECT name FROM users WHERE id = $1`,
      [targetUserId]
    );
    const userName = userResult.rows[0]?.name || 'User';

    // Get verifier name
    const verifierResult = await client.query(
      `SELECT name FROM users WHERE id = $1`,
      [userId]
    );
    const verifierName = verifierResult.rows[0]?.name || 'User';

    // Log activity
    const verifierRole = isCreator ? 'Creator' : 'Reporting member';
    await logTaskActivity(client, {
      taskId,
      userId,
      activityType: 'completion_verified',
      message: `${verifierRole} (${verifierName}) verified ${userName}'s completion`,
    });

    // Check if all assignees who completed have been verified.
    // Creator may be in task_assignees but without completed_at (they verify, not "do").
    // Task is done when: every assignee with completed_at also has verified_at.
    const allAssigneesResult = await client.query(
      `SELECT 
        COUNT(CASE WHEN completed_at IS NOT NULL THEN 1 END) as completed_count,
        COUNT(CASE WHEN completed_at IS NOT NULL AND verified_at IS NOT NULL THEN 1 END) as verified_completed_count
       FROM task_assignees 
       WHERE task_id = $1`,
      [taskId]
    );

    const completedCount = parseInt(allAssigneesResult.rows[0].completed_count) || 0;
    const verifiedCompletedCount = parseInt(allAssigneesResult.rows[0].verified_completed_count) || 0;

    // If all who completed are verified (and at least one completed), mark task as completed
    const allCompletedAndVerified = completedCount > 0 && completedCount === verifiedCompletedCount;

    // Mark task completed so assignees (e.g. Dilli) see Completed. Creator still sees In Progress in Self until they mark complete (dashboard logic).
    if (allCompletedAndVerified) {
      await client.query(
        `UPDATE tasks SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [taskId]
      );
      await logTaskActivity(client, {
        taskId,
        userId,
        activityType: 'task_completed',
        message: 'All members completed and verified - Task completed',
      });
    }

    await client.query('COMMIT');
    res.json({ message: 'Completion verified successfully', allCompleted: allCompletedAndVerified });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Verify completion error:', error);
    res.status(500).json({ error: 'Failed to verify completion' });
  } finally {
    client.release();
  }
};

/**
 * Reassign a member's work (send back from completed to in-progress)
 * - Reporting member can reassign regular assignees
 * - Creator can reassign reporting member, or any assignee when no reporting member exists
 */
export const reassignMember = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id: taskId, userId: targetUserId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Load task with creator + reporting member (source of truth: task_assignees.role; fallback: tasks)
    const taskResult = await client.query(
      `SELECT 
        t.id,
        COALESCE(t.created_by, t.creator_id) as legacy_creator_id,
        t.reporting_member_id as legacy_reporting_member_id,
        (SELECT ta_c.user_id FROM task_assignees ta_c WHERE ta_c.task_id = t.id AND ta_c.role = 'creator' LIMIT 1) as role_creator_id,
        (SELECT ta_r.user_id FROM task_assignees ta_r WHERE ta_r.task_id = t.id AND ta_r.role = 'reporting_member' LIMIT 1) as role_reporting_member_id
       FROM tasks t
       WHERE t.id = $1`,
      [taskId]
    );

    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];
    const creatorId = (task.role_creator_id || task.legacy_creator_id) as string | null;
    const reportingMemberId = (task.role_reporting_member_id || task.legacy_reporting_member_id) as string | null;
    const isCreator = !!creatorId && String(creatorId) === String(userId);
    const isReportingMember = !!reportingMemberId && String(reportingMemberId) === String(userId);

    if (!isCreator && !isReportingMember) {
      return res.status(403).json({
        error: 'Only the task creator or reporting member can reassign work',
      });
    }

    // Load target assignee row
    const assigneeResult = await client.query(
      `SELECT user_id, completed_at, verified_at
       FROM task_assignees
       WHERE task_id = $1 AND user_id = $2`,
      [taskId, targetUserId]
    );

    if (assigneeResult.rows.length === 0) {
      return res.status(404).json({ error: 'User is not assigned to this task' });
    }

    const assigneeRow = assigneeResult.rows[0];

    if (!assigneeRow.completed_at) {
      return res.status(400).json({ error: 'User has not completed the task yet' });
    }

    // Permission rules
    if (isReportingMember) {
      // Reporting member can only reassign regular assignees (not creator or themselves)
      if (String(assigneeRow.user_id) === userId) {
        return res.status(403).json({
          error: 'Reporting member cannot reassign their own work. Creator must reassign it.',
        });
      }
      if (creatorId && String(assigneeRow.user_id) === creatorId) {
        return res.status(403).json({
          error: 'Reporting member cannot reassign creator’s work',
        });
      }
    } else if (isCreator) {
      // When reporting member exists, creator should reassign the reporting member only
      if (reportingMemberId) {
        if (String(assigneeRow.user_id) !== String(reportingMemberId)) {
          return res.status(403).json({
            error: 'Creator can only reassign the reporting member when one is configured.',
          });
        }
      }
    }

    // Reassign: send user back to in-progress
    await client.query(
      `UPDATE task_assignees
       SET completed_at = NULL,
           verified_at = NULL,
           status = 'inprogress'
       WHERE task_id = $1 AND user_id = $2`,
      [taskId, targetUserId]
    );

    // Fetch names for logging
    const [actorResult, targetResult] = await Promise.all([
      client.query(`SELECT name FROM users WHERE id = $1`, [userId]),
      client.query(`SELECT name FROM users WHERE id = $1`, [targetUserId]),
    ]);

    const actorName = actorResult.rows[0]?.name || 'User';
    const targetName = targetResult.rows[0]?.name || 'User';
    const actorRole = isCreator ? 'Creator' : 'Reporting member';

    await logTaskActivity(client, {
      taskId,
      userId,
      activityType: 'task_reassigned',
      message: `${actorRole} (${actorName}) reassigned work to ${targetName}`,
    });

    await client.query('COMMIT');
    res.json({ message: 'Task reassigned successfully' });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Reassign member error:', error);
    res.status(500).json({ error: 'Failed to reassign task' });
  } finally {
    client.release();
  }
};

/**
 * Add assignees to an existing task - allows task assignees to add more users
 */
export const addTaskAssignees = async (req: AuthRequest, res: Response) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const userId = req.user?.userId;
    const { id } = req.params;
    const { assignee_ids } = req.body;

    if (!userId) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!assignee_ids || !Array.isArray(assignee_ids) || assignee_ids.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'assignee_ids array is required' });
    }

    // Check if task exists
    const taskResult = await client.query(
      `SELECT id, created_by, creator_id, start_date, title FROM tasks WHERE id = $1`,
      [id]
    );

    if (taskResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];
    const taskCreatorId = task.created_by || task.creator_id;

    // Check if user is assigned to this task OR is the creator
    const assigneeCheck = await client.query(
      `SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (assigneeCheck.rows.length === 0 && taskCreatorId !== userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You must be assigned to this task to add assignees' });
    }

    // Get existing assignee IDs
    const existingAssigneesResult = await client.query(
      `SELECT user_id FROM task_assignees WHERE task_id = $1`,
      [id]
    );
    const existingAssigneeIds = existingAssigneesResult.rows.map(r => r.user_id);

    // Add new assignees (skip ones that already exist)
    const newAssigneeIds = assignee_ids.filter((aid: string) => !existingAssigneeIds.includes(aid));
    
    if (newAssigneeIds.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'All provided users are already assigned to this task' });
    }

    // Insert new assignees — accepted immediately (no separate accept step).
    for (const assigneeId of newAssigneeIds) {
      const assigneeStatus = resolveInitialAssigneeStatus({ startDate: task.start_date });
      await client.query(
        `INSERT INTO task_assignees (task_id, user_id, status, role, accepted_at)
         VALUES ($1, $2, $3, 'member', CURRENT_TIMESTAMP)
         ON CONFLICT (task_id, user_id) DO UPDATE
         SET status = EXCLUDED.status,
             accepted_at = COALESCE(task_assignees.accepted_at, CURRENT_TIMESTAMP)`,
        [id, assigneeId, assigneeStatus]
      );
    }

    // Add new assignees to task group conversation immediately (no separate accept step).
    let conversationId: string | null = null;
    const conversationResult = await client.query(
      `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
      [id]
    );
    if (conversationResult.rows.length > 0) {
      conversationId = conversationResult.rows[0].id;
      for (const assigneeId of newAssigneeIds) {
        await client.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT (conversation_id, user_id) DO NOTHING`,
          [conversationId, assigneeId]
        );
      }
    }

    // Log activity
    await client.query(
      `INSERT INTO task_activities (task_id, user_id, activity_type, message)
       VALUES ($1, $2, 'assignees_added', $3)`,
      [id, userId, `Added ${newAssigneeIds.length} new assignee(s) to the task`]
    );

    await client.query('COMMIT');

    try {
      const io = (req.app as any).get('io');
      await notifyNewTaskAssignees({
        io,
        taskId: id,
        conversationId,
        newAssigneeIds,
        addedByUserId: userId,
        taskTitle: task.title,
      });
    } catch (notifyError: any) {
      console.warn('[addTaskAssignees] notify failed:', notifyError?.message || notifyError);
    }

    // Fetch updated task with all assignees
    const updatedTaskResult = await client.query(
      `SELECT 
        t.*,
        json_agg(
          DISTINCT jsonb_build_object(
            'id', u.id,
            'name', u.name,
            'phone', u.mobile,
            'profile_photo', u.profile_photo_url,
            'accepted_at', ta.accepted_at,
            'has_accepted', CASE WHEN ta.accepted_at IS NOT NULL THEN true ELSE false END,
            'assignee_status', ta.status,
            'role', ta.role
          )
        ) FILTER (WHERE u.id IS NOT NULL) as assignees
      FROM tasks t
      LEFT JOIN task_assignees ta ON t.id = ta.task_id
      LEFT JOIN users u ON ta.user_id = u.id
      WHERE t.id = $1
      GROUP BY t.id`,
      [id]
    );

    res.json({ 
      success: true, 
      message: `Added ${newAssigneeIds.length} assignee(s) successfully`,
      task: updatedTaskResult.rows[0],
      added_count: newAssigneeIds.length
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Add task assignees error:', error);
    res.status(500).json({ error: 'Failed to add assignees to task' });
  } finally {
    client.release();
  }
};

/**
 * Add the same assignee(s) to multiple tasks (task dashboard bulk assign).
 */
export const bulkAddTaskAssignees = async (req: AuthRequest, res: Response) => {
  const userId = req.user?.userId;
  const { task_ids: taskIdsRaw, assignee_ids: assigneeIdsRaw } = req.body || {};

  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!Array.isArray(taskIdsRaw) || taskIdsRaw.length === 0) {
    return res.status(400).json({ error: 'task_ids array is required' });
  }
  if (!Array.isArray(assigneeIdsRaw) || assigneeIdsRaw.length === 0) {
    return res.status(400).json({ error: 'assignee_ids array is required' });
  }

  const taskIds = [...new Set(taskIdsRaw.map((id: unknown) => String(id).trim()).filter(Boolean))].slice(
    0,
    100
  );
  const assigneeIds = [
    ...new Set(assigneeIdsRaw.map((id: unknown) => String(id).trim()).filter(Boolean)),
  ].slice(0, 50);

  if (taskIds.length === 0 || assigneeIds.length === 0) {
    return res.status(400).json({ error: 'Valid task_ids and assignee_ids are required' });
  }

  const results: Array<{
    task_id: string;
    success: boolean;
    added_count?: number;
    error?: string;
  }> = [];

  for (const taskId of taskIds) {
    const client = await getClient();
    try {
      await client.query('BEGIN');

      const taskResult = await client.query(
        `SELECT id, created_by, creator_id, start_date, title FROM tasks WHERE id = $1`,
        [taskId]
      );

      if (taskResult.rows.length === 0) {
        await client.query('ROLLBACK');
        results.push({ task_id: taskId, success: false, error: 'Task not found' });
        continue;
      }

      const task = taskResult.rows[0];
      const taskCreatorId = task.created_by || task.creator_id;

      const assigneeCheck = await client.query(
        `SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
        [taskId, userId]
      );

      if (
        assigneeCheck.rows.length === 0 &&
        String(taskCreatorId ?? '') !== String(userId)
      ) {
        await client.query('ROLLBACK');
        results.push({
          task_id: taskId,
          success: false,
          error: 'You must be assigned to this task to add assignees',
        });
        continue;
      }

      const existingAssigneesResult = await client.query(
        `SELECT user_id FROM task_assignees WHERE task_id = $1`,
        [taskId]
      );
      const existingAssigneeIds = new Set(
        existingAssigneesResult.rows.map((r: { user_id: string }) => String(r.user_id))
      );
      const newAssigneeIds = assigneeIds.filter((aid) => !existingAssigneeIds.has(aid));

      if (newAssigneeIds.length === 0) {
        await client.query('COMMIT');
        results.push({ task_id: taskId, success: true, added_count: 0 });
        continue;
      }

      const assigneeStatus = resolveInitialAssigneeStatus({ startDate: task.start_date });
      for (const assigneeId of newAssigneeIds) {
        await client.query(
          `INSERT INTO task_assignees (task_id, user_id, status, role, accepted_at)
           VALUES ($1, $2, $3, 'member', CURRENT_TIMESTAMP)
           ON CONFLICT (task_id, user_id) DO UPDATE
           SET status = EXCLUDED.status,
               accepted_at = COALESCE(task_assignees.accepted_at, CURRENT_TIMESTAMP)`,
          [taskId, assigneeId, assigneeStatus]
        );
      }

      let conversationId: string | null = null;
      const conversationResult = await client.query(
        `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
        [taskId]
      );
      if (conversationResult.rows.length > 0) {
        conversationId = conversationResult.rows[0].id;
        for (const assigneeId of newAssigneeIds) {
          await client.query(
            `INSERT INTO conversation_members (conversation_id, user_id, role)
             VALUES ($1, $2, 'member')
             ON CONFLICT (conversation_id, user_id) DO NOTHING`,
            [conversationId, assigneeId]
          );
        }
      }

      await client.query(
        `INSERT INTO task_activities (task_id, user_id, activity_type, message)
         VALUES ($1, $2, 'assignees_added', $3)`,
        [taskId, userId, `Added ${newAssigneeIds.length} new assignee(s) to the task`]
      );

      await client.query('COMMIT');

      try {
        const io = (req.app as any).get('io');
        await notifyNewTaskAssignees({
          io,
          taskId,
          conversationId,
          newAssigneeIds,
          addedByUserId: userId,
          taskTitle: task.title,
        });
      } catch (notifyError: any) {
        console.warn('[bulkAddTaskAssignees] notify failed:', notifyError?.message || notifyError);
      }

      results.push({ task_id: taskId, success: true, added_count: newAssigneeIds.length });
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error('Bulk add assignees error for task', taskId, error);
      results.push({
        task_id: taskId,
        success: false,
        error: error?.message || 'Failed to add assignees',
      });
    } finally {
      client.release();
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const totalAdded = results.reduce((sum, r) => sum + (r.added_count || 0), 0);

  return res.json({
    success: failed === 0,
    results,
    summary: {
      tasks_requested: taskIds.length,
      tasks_succeeded: succeeded,
      tasks_failed: failed,
      assignees_added_total: totalAdded,
    },
  });
};

/**
 * Get all assignees for a task - allows task members to see all assignees
 */
export const getTaskAssignees = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Check if user has access to the task (must be assigned or creator)
    const accessCheck = await query(
      `SELECT t.id 
       FROM tasks t
       WHERE t.id = $1 
       AND (
         EXISTS (
           SELECT 1 
           FROM task_assignees ta_check 
           WHERE ta_check.task_id = t.id AND ta_check.user_id = $2
         )
         OR COALESCE(t.created_by, t.creator_id) = $2
       )`,
      [id, userId]
    );

    if (accessCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Get all assignees for the task
    const assigneesResult = await query(
      `SELECT 
        u.id,
        u.name,
        u.mobile,
        u.profile_photo_url,
        ta.role,
        ta.status as assignee_status,
        ta.accepted_at,
        CASE WHEN ta.accepted_at IS NOT NULL THEN true ELSE false END as has_accepted,
        NULL::text as department,
        NULL::text as designation,
        u.status
      FROM task_assignees ta
      INNER JOIN users u ON ta.user_id = u.id
      WHERE ta.task_id = $1
      ORDER BY u.name ASC`,
      [id]
    );

    res.json({ assignees: assigneesResult.rows });
  } catch (error: any) {
    console.error('Get task assignees error:', error);
    res.status(500).json({ error: 'Failed to fetch task assignees' });
  }
};