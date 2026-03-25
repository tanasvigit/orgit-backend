import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import { query, getClient } from '../config/database';
import { getReminderConfig } from '../services/platformSettingsService';
import { computeTaskAndMemberStatuses } from '../services/taskStatusEngine';
import { logTaskActivity } from '../services/taskActivityLogger';

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

const calculateNextRecurrenceDateLocal = (
  frequency: 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'specific_weekday',
  specificWeekday: number | null,
  baseDate: Date
): Date => {
  const base = new Date(baseDate);
  const next = new Date(base);

  switch (frequency) {
    case 'weekly':
      next.setDate(next.getDate() + 7);
      return next;
    case 'monthly':
      return addMonthsClamped(base, 1);
    case 'quarterly':
      return addMonthsClamped(base, 3);
    case 'yearly':
      return addMonthsClamped(base, 12);
    case 'specific_weekday': {
      if (specificWeekday === null || specificWeekday === undefined) return next;
      const current = next.getDay();
      const daysUntilNext = (specificWeekday - current + 7) % 7 || 7;
      next.setDate(next.getDate() + daysUntilNext);
      return next;
    }
    default:
      return next;
  }
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

    let querySQL = `
      SELECT 
        t.*,
        COALESCE(MAX(ce.name), MAX(t.client_name)) as client_name,
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
            'department', (
              SELECT uo2.department 
              FROM user_organizations uo2 
              WHERE uo2.user_id = u.id 
              LIMIT 1
            ),
            'designation', (
              SELECT uo2.designation 
              FROM user_organizations uo2 
              WHERE uo2.user_id = u.id 
              LIMIT 1
            ),
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
            'role', ta3.role
          )
          FROM task_assignees ta3
          WHERE ta3.task_id = t.id AND ta3.user_id = $1
        ) as current_user_status,
        c.id as conversation_id,
        c.name as conversation_name
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
    `;

    const params: any[] = [userId];
    const conditions: string[] = [];

    // Filter by task type (one_time vs recurring)
    // Priority: task_type field takes precedence
    // - If task_type = 'one_time': always show in one_time (regardless of recurrence_type)
    // - If task_type = 'recurring': always show in recurring
    // - If task_type IS NULL: use recurrence_type to determine
    if (type === 'recurring') {
      // Show recurring tasks: explicitly marked as recurring OR (no type set AND has recurrence_type)
      conditions.push(`(t.task_type = $${params.length + 1} OR (t.task_type IS NULL AND t.recurrence_type IS NOT NULL))`);
      params.push('recurring');

      // Recurring visibility: show only tasks within the due-soon window (today..today+dueSoonDays),
      // unless explicitly requested to include all. Default 3 days from reminder settings.
      if (!includeAll) {
        const reminderConfig = await getReminderConfig();
        const dueSoonDays = Number(reminderConfig?.dueSoonDays ?? 3);
        const safeDueSoonDays = Number.isFinite(dueSoonDays) ? Math.max(0, Math.min(60, dueSoonDays)) : 3;
        conditions.push(`t.due_date >= CURRENT_DATE AND t.due_date <= CURRENT_DATE + ($${params.length + 1} || ' days')::interval`);
        params.push(safeDueSoonDays);
      }
    } else if (type === 'one_time') {
      // Show one-time tasks: explicitly marked as one_time OR (no type set AND no recurrence)
      conditions.push(`(t.task_type = $${params.length + 1} OR (t.task_type IS NULL AND t.recurrence_type IS NULL))`);
      params.push('one_time');
      // Show tasks due within due-soon window OR created by/assigned to user in last 30 days (so newly created tasks are visible)
      if (!includeAll) {
        const reminderConfig = await getReminderConfig();
        const dueSoonDays = Number(reminderConfig?.dueSoonDays ?? 3);
        const safeDueSoonDays = Number.isFinite(dueSoonDays) ? Math.max(0, Math.min(60, dueSoonDays)) : 3;
        conditions.push(
          `(t.due_date IS NOT NULL AND t.due_date <= CURRENT_DATE + ($${params.length + 1} || ' days')::interval` +
          ` OR t.created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days')`
        );
        params.push(safeDueSoonDays);
      }
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
    // Prevent caching so clients always get full body (avoid 304 with empty body breaking task list)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');

    const rowsWithStatus = result.rows.map((row: any) => {
      const assignees = Array.isArray(row.assignees) ? row.assignees : [];
      const computed = computeTaskAndMemberStatuses(row, assignees, userId);
      // Optional helper flag so clients can easily hide lifecycle status
      // before the configured start_date of the task.
      let isBeforeStartDate: boolean | null = null;
      if (row.start_date) {
        try {
          const start = new Date(row.start_date as any);
          const today = new Date();
          start.setHours(0, 0, 0, 0);
          today.setHours(0, 0, 0, 0);
          isBeforeStartDate = start.getTime() > today.getTime();
        } catch {
          isBeforeStartDate = null;
        }
      }
      return {
        ...row,
        task_status: computed.taskStatus,
        member_statuses: computed.memberStatuses,
        current_user_member_status: computed.currentUserMemberStatus,
        is_before_start_date: isBeforeStartDate,
      };
    });

    res.json({ tasks: rowsWithStatus });
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

    // First check if task exists and user has access
    const accessCheck = await query(
      `SELECT t.id 
       FROM tasks t
       WHERE t.id = $1 
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
        COALESCE(MAX(ce.name), MAX(t.client_name)) as client_name,
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
            'department', (
              SELECT uo2.department 
              FROM user_organizations uo2 
              WHERE uo2.user_id = u.id 
              LIMIT 1
            ),
            'designation', (
              SELECT uo2.designation 
              FROM user_organizations uo2 
              WHERE uo2.user_id = u.id 
              LIMIT 1
            ),
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
    task.task_status = computed.taskStatus;
    task.member_statuses = computed.memberStatuses;
    if (computed.currentUserMemberStatus) {
      (task as any).current_user_member_status = computed.currentUserMemberStatus;
    }

    res.json({ task });
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
    } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    // For recurring monthly tasks, allow deriving due_date from recurrence_day_of_month (no start_date used)
    let finalDueDate: string | null = due_date || null;
    if (!finalDueDate && task_type === 'recurring' && recurrence_type === 'monthly' && recurrence_day_of_month) {
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

    if (!finalDueDate) {
      return res.status(400).json({ error: 'Due date is required' });
    }

    // Determine actual task owner/creator
    const taskCreatorId: string = (creator_id && typeof creator_id === 'string' ? creator_id : userId) as string;
    const isDifferentOwner = taskCreatorId !== userId;

    // If the task is being created on behalf of another user, store metadata in escalation_rules.
    // This is used later to prevent the original requester from joining the task group conversation.
    let finalEscalationRules = escalation_rules;
    if (isDifferentOwner) {
      finalEscalationRules = {
        ...(escalation_rules || {}),
        _metadata: {
          ...(escalation_rules?._metadata || {}),
          original_creator_id: userId,
          task_creator_id: taskCreatorId,
        },
      };
    }

    // Get user's organization_id
    let organizationId = req.user?.organizationId;
    if (!organizationId) {
      // Fetch from database if not in JWT
      const orgResult = await client.query(
        `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
        [userId]
      );
      organizationId = orgResult.rows[0]?.organization_id || null;
    }
    
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
           'end_date',
           'status'
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
    const hasEndDate = columnCheck.rows.some((r: any) => r.column_name === 'end_date');
    const hasStatusColumn = columnCheck.rows.some((r: any) => r.column_name === 'status');
    const hasTaskRolloutType = columnCheck.rows.some((r: any) => r.column_name === 'task_rollout_type');

    const normalizedRecurrenceType =
      typeof recurrence_type === 'string' ? recurrence_type.toLowerCase() : null;
    // Weekly schedules are day-of-week based, so we store them as specific_weekday frequency.
    const frequency =
      normalizedRecurrenceType === 'weekly'
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
    const normalizedSpecificWeekday =
      typeof specific_weekday === 'number'
        ? specific_weekday
        : typeof specific_weekday === 'string'
        ? Number(specific_weekday)
        : null;
    const specificWeekdayValue =
      frequency === 'specific_weekday' && normalizedSpecificWeekday !== null
        ? normalizedSpecificWeekday
        : null;
    const nextRecurrenceDate =
      task_type === 'recurring' && frequency
        ? calculateNextRecurrenceDateLocal(
            frequency,
            specificWeekdayValue,
            new Date(finalDueDate)
          )
        : null;

    // Determine initial task.status for recurring tasks at creation time so the first cycle behaves like later recurrences.
    let initialStatusForInsert: string | null = null;
    if (task_type === 'recurring') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const due = new Date(finalDueDate);
      const dueMidnight = new Date(due);
      dueMidnight.setHours(0, 0, 0, 0);
      const diffMs = dueMidnight.getTime() - today.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      // If due date is today or already passed, start in progress immediately.
      if (diffDays <= 0) {
        initialStatusForInsert = 'in_progress';
      } else {
        // Otherwise keep as 'pending' (todo) – 3-days-before/on-date job will maintain the cycle.
        initialStatusForInsert = 'pending';
      }
    }
    
    // Build INSERT statement with both columns if they exist
    let insertColumns = ['title', 'description', 'task_type'];
    let insertValues = [title, description, task_type || 'one_time'];
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
    insertColumns.push('start_date', 'target_date', 'due_date');
    insertValues.push(start_date || null, target_date || null, finalDueDate);

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

    insertColumns.push('recurrence_type', 'recurrence_interval', 'auto_escalate', 'escalation_rules');
    insertValues.push(
      recurrence_type || null,
      recurrence_interval || 1,
      auto_escalate || false,
      finalEscalationRules ? JSON.stringify(finalEscalationRules) : null
    );

    if (hasTaskRolloutType) {
      insertColumns.push('task_rollout_type');
      insertValues.push(
        task_rollout_type === 'start_date' || task_rollout_type === 'cycle_start'
          ? task_rollout_type
          : 'cycle_start'
      );
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

    if (hasEndDate && end_date) {
      insertColumns.push('end_date');
      insertValues.push(end_date);
    }
    
    // Build parameterized query
    const placeholders = insertValues.map((_, i) => `$${i + 1}`).join(', ');
    
    const taskResult = await client.query(
      `INSERT INTO tasks (${insertColumns.join(', ')})
       VALUES (${placeholders})
       RETURNING *`,
      insertValues
    );

    const task = taskResult.rows[0];

    // Assign task to users.
    // IMPORTANT: If no assignee_ids are provided, we keep the task unassigned (no task_assignees rows).
    // The creator can still see it via tasks.created_by / tasks.creator_id.
    let hasAssignees = false;
    const rawIds = Array.isArray(assignee_ids) ? assignee_ids : [];
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

    // If start_date ≤ created_at → todo (on dashboard). If start_date > created_at → scheduled (not on dashboard).
    const startAt = task.start_date ? new Date(task.start_date).getTime() : null;
    const createdAt = task.created_at ? new Date(task.created_at).getTime() : Date.now();
    const assigneeStatus =
      startAt != null && startAt > createdAt ? 'scheduled' : 'todo';

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
          `INSERT INTO task_assignees (task_id, user_id, status, role)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (task_id, user_id) DO NOTHING`,
          [task.id, assigneeId, assigneeStatus, role]
        );
      }
      // Keep task as 'pending' when assignees are added; task moves to 'in_progress' only after assignee(s) accept.
    } else {
      // No assignees: add creator as sole assignee so they get todo/scheduled status and task appears in Self
      hasAssignees = true;
      await client.query(
        `INSERT INTO task_assignees (task_id, user_id, status, role)
         VALUES ($1, $2, $3, 'creator')
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [task.id, taskCreatorId, assigneeStatus]
      );
    }

    // Create task activity log
    const initialStatus = 'pending';
    const createdActivitySuffix = hasAssignees
      ? ' with assignees - Pending acceptance'
      : '';
    await logTaskActivity(client, {
      taskId: task.id,
      userId,
      activityType: 'created',
      newValue: initialStatus,
      message: `Task "${title}" created${createdActivitySuffix}`,
    });

    // Auto-create task group conversation
    const conversationResult = await client.query(
      `INSERT INTO conversations (id, type, name, is_group, is_task_group, task_id, created_by)
       VALUES (gen_random_uuid(), 'group', $1, TRUE, TRUE, $2, $3)
       RETURNING *`,
      [`Task: ${title}`, task.id, taskCreatorId]
    );

    const conversation = conversationResult.rows[0];

    // Get task owner's name for the welcome message
    const creatorResult = await client.query(
      `SELECT name FROM users WHERE id = $1`,
      [taskCreatorId]
    );
    const creatorName = creatorResult.rows[0]?.name || 'Admin';

    // Add only creator (admin) to conversation initially
    // Assignees will be added only when they accept the task
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       VALUES ($1, $2, 'admin')
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversation.id, taskCreatorId]
    );

    // EXTRA SAFETY: ensure requester isn't in the conversation if they created on behalf of someone else
    if (isDifferentOwner) {
      await client.query(
        `DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
        [conversation.id, userId]
      );
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

    // Fetch full task with assignees
    const fullTaskResult = await query(
      `SELECT 
        t.*,
        COALESCE(MAX(ce.name), MAX(t.client_name)) as client_name,
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

    res.status(201).json({ task: fullTaskResult.rows[0] });
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

    if (!['pending', 'in_progress', 'completed', 'rejected'].includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: pending, in_progress, completed, rejected. Received: ${status}` });
    }

    // First check if task exists
    const taskCheck = await query(
      `SELECT 
        id,
        COALESCE(created_by, creator_id) as creator_id,
        EXISTS (SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2) as is_assignee,
        EXISTS (SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2 AND role = 'creator') as is_creator_role
       FROM tasks 
       WHERE id = $1`,
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

    res.json({ task: result.rows[0] });
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

    // Build dynamic update query
    const allowedFields = ['title', 'description', 'client_name', 'start_date', 'target_date', 'due_date'];
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

    res.json({ task: result.rows[0] });
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

    // Delete task (cascades to task_assignees, task_activities, etc. per schema)
    await client.query(`DELETE FROM tasks WHERE id = $1`, [id]);

    await client.query('COMMIT');
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

    // Check if user has accepted the task (creators can skip acceptance)
    const hasAccepted = !!assigneeCheck.rows[0].accepted_at;
    
    if (!isCreator && !hasAccepted) {
      return res.status(400).json({ error: 'You must accept the task before marking it as complete' });
    }
    
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
      `SELECT id, created_by, creator_id, start_date FROM tasks WHERE id = $1`,
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

    // Insert new assignees
    for (const assigneeId of newAssigneeIds) {
      const now = new Date();
      const startAt = task.start_date ? new Date(task.start_date).getTime() : null;
      const assigneeStatus = startAt != null && now.getTime() < startAt ? 'scheduled' : 'todo';
      await client.query(
        `INSERT INTO task_assignees (task_id, user_id, status, role)
         VALUES ($1, $2, $3, 'member')
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [id, assigneeId, assigneeStatus]
      );
    }

    // NOTE: Do not add assignees to the task group conversation here.
    // Assignees will join the task group conversation only when they accept the task (acceptTask).

    // Log activity
    await client.query(
      `INSERT INTO task_activities (task_id, user_id, activity_type, message)
       VALUES ($1, $2, 'assignees_added', $3)`,
      [id, userId, `Added ${newAssigneeIds.length} new assignee(s) to the task`]
    );

    await client.query('COMMIT');

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
        (
          SELECT uo.department 
          FROM user_organizations uo 
          WHERE uo.user_id = u.id 
          LIMIT 1
        ) as department,
        (
          SELECT uo.designation 
          FROM user_organizations uo 
          WHERE uo.user_id = u.id 
          LIMIT 1
        ) as designation,
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