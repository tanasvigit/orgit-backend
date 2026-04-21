import { query } from '../config/database';
import { getReminderConfig } from './platformSettingsService';

/** Task row from dashboard query plus computed fields (no dependency on shared types) */
export interface DashboardTask {
  id?: string;
  title?: string;
  status?: string;
  category?: string;
  due_date?: string | Date | null;
  start_date?: string | Date | null;
  compliance_id?: string | null;
  isSelfTask: boolean;
  assignmentStatus?: string | null;
  daysUntilDue?: number | null;
  [key: string]: unknown;
}

export interface TaskCategoryGroup {
  scheduled: DashboardTask[];
  todo: DashboardTask[];
  overdue: DashboardTask[];
  dueSoon: DashboardTask[];
  inProgress: DashboardTask[];
  completed: DashboardTask[];
}

export interface DashboardData {
  selfTasks: {
    general: TaskCategoryGroup;
    documentManagement: TaskCategoryGroup;
    complianceManagement: TaskCategoryGroup;
  };
  assignedTasks: {
    general: TaskCategoryGroup;
    documentManagement: TaskCategoryGroup;
    complianceManagement: TaskCategoryGroup;
  };
}

/**
 * Calculate days until due date
 */
const calculateDaysUntilDue = (dueDate: Date | null): number | null => {
  if (!dueDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  const diffTime = due.getTime() - today.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
};

/**
 * Categorize task by status
 *
 * Status Flow:
 * - SCHEDULED: Current date-time is before task start_date (full timestamp); show only after start_date in todo/inProgress.
 * - TODO: Task pending and not yet accepted by assignee (creator sees "assigned, waiting"; assignee sees "I need to accept")
 * - In Progress: Task accepted (or in_progress); work in progress
 * - Completed: User completed and verified
 * - Overdue / Due Soon: By due date
 */
const categorizeTask = (
  task: DashboardTask,
  dueSoonDays: number = 3
): 'scheduled' | 'todo' | 'overdue' | 'dueSoon' | 'inProgress' | 'completed' => {
  const hasNoDates = !task.start_date && !task.due_date;
  // 0. Before start_date (date+time): task is scheduled; display in todo only when current date-time >= start_date
  if (task.start_date) {
    const now = new Date();
    const start = new Date(task.start_date as string | Date);
    if (now < start) return 'scheduled';
  }

  // 1. Self tasks: if current user has completed_at and verified_at, show as Completed
  const userCompletedAndVerified =
    (task as any).current_user_completed_at != null && (task as any).current_user_verified_at != null;
  if (userCompletedAndVerified) {
    return 'completed';
  }
  // 1. Completed tasks - but for creator in Self, show In Progress until they mark complete
  if (task.status === 'completed') {
    if ((task as any).is_creator) return 'inProgress';
    return 'completed';
  }

  // No-date tasks must never go to overdue/dueSoon buckets.
  if (hasNoDates) {
    const isSelfTask = (task as any).isSelfTask === true;
    const currentUserAcceptedAt = (task as any).current_user_accepted_at;
    const acceptedAssigneeCount = (task as any).accepted_assignee_count;
    const noOneAccepted =
      isSelfTask
        ? currentUserAcceptedAt == null
        : (acceptedAssigneeCount == null || Number(acceptedAssigneeCount) === 0);
    return noOneAccepted ? 'todo' : 'inProgress';
  }

  // 2. Overdue: by date
  const daysUntilDue = task.daysUntilDue;
  if (daysUntilDue != null && daysUntilDue < 0) {
    return 'overdue';
  }
  if (task.status === 'overdue') {
    return 'overdue';
  }

  // 3. Due Soon: by date
  if (daysUntilDue != null && daysUntilDue >= 0 && daysUntilDue <= dueSoonDays) {
    return 'dueSoon';
  }

  // 4. TODO: No assignee has accepted yet (use accepted_at counts, not tasks.status)
  // Self task: current user is assignee and has not accepted
  // Assigned task: current user is creator; no assignee has accepted yet
  const isSelfTask = (task as any).isSelfTask === true;
  const currentUserAcceptedAt = (task as any).current_user_accepted_at;
  const acceptedAssigneeCount = (task as any).accepted_assignee_count;
  const noOneAccepted =
    isSelfTask
      ? currentUserAcceptedAt == null
      : (acceptedAssigneeCount == null || Number(acceptedAssigneeCount) === 0);
  if (noOneAccepted) {
    return 'todo';
  }

  // 5. In Progress: at least one assignee has accepted (or task completed/overdue handled above)
  return 'inProgress';
};

/**
 * Get dashboard data for a user
 */
export const getDashboardData = async (
  userId: string,
  dueSoonDays?: number
): Promise<DashboardData> => {
  // Get due soon days from platform settings if not provided
  if (dueSoonDays === undefined) {
    const reminderConfig = await getReminderConfig();
    dueSoonDays = reminderConfig.dueSoonDays;
  }
  // Get self tasks: Tasks assigned to user (they need to complete these)
  // Logic:
  // - If current user is creator AND there are other assignees -> task is in Assigned section
  // - Otherwise -> task is in Self section (includes creator-only tasks)
  const selfTasksResult = await query(
    `SELECT DISTINCT
      t.*,
      true as is_self_task,
      ta.completed_at as current_user_completed_at,
      ta.verified_at as current_user_verified_at,
      ta.accepted_at as current_user_accepted_at,
      CASE WHEN EXISTS (SELECT 1 FROM task_assignees ta2 WHERE ta2.task_id = t.id) 
           THEN 'has_assignees'
           ELSE ta.accepted_at::text
      END as assignment_status,
      t.due_date,
      t.reporting_member_id,
      -- Current user's role (source of truth)
      CASE WHEN COALESCE(ta.role, 'member') = 'creator' THEN true ELSE false END as is_creator,
      CASE WHEN COALESCE(ta.role, 'member') = 'reporting_member' THEN true ELSE false END as is_reporting_member,
      -- For creator: task moves to self when all who completed are verified
      CASE 
        WHEN COALESCE(ta.role, 'member') = 'creator' THEN
          (SELECT COUNT(CASE WHEN completed_at IS NOT NULL THEN 1 END) > 0
           AND COUNT(CASE WHEN completed_at IS NOT NULL THEN 1 END) = COUNT(CASE WHEN completed_at IS NOT NULL AND verified_at IS NOT NULL THEN 1 END)
           FROM task_assignees ta_all WHERE ta_all.task_id = t.id AND ta_all.user_id != $1)
        ELSE false
      END as all_members_verified,
      -- For reporting member: all their reporting members who completed have verified_at
      CASE 
        WHEN COALESCE(ta.role, 'member') = 'reporting_member' THEN
          (SELECT COUNT(CASE WHEN completed_at IS NOT NULL THEN 1 END) > 0
           AND COUNT(CASE WHEN completed_at IS NOT NULL THEN 1 END) = COUNT(CASE WHEN completed_at IS NOT NULL AND verified_at IS NOT NULL THEN 1 END)
           FROM task_assignees ta_rm 
           WHERE ta_rm.task_id = t.id 
             AND ta_rm.user_id != $1 
             AND ta_rm.user_id != COALESCE(t.created_by, t.creator_id))
        ELSE false
      END as all_reporting_members_verified,
      -- Per-user status for overview: has_accepted, has_rejected, assignee_status (todo/inprogress/completed) for display
      jsonb_build_object('has_accepted', ta.accepted_at IS NOT NULL, 'has_rejected', false, 'assignee_status', ta.status) as current_user_status
     FROM tasks t
     INNER JOIN task_assignees ta ON t.id = ta.task_id
     WHERE ta.user_id = $1
      AND COALESCE(t.is_recurring_template, false) = false
      AND COALESCE(t.task_type, 'one_time') != 'recurring_template'
       AND (ta.status IS NULL OR ta.status != 'scheduled')
       AND (
          -- Non-creator roles are always Self
          COALESCE(ta.role, 'member') <> 'creator'
          OR
          -- Creator-only task (no other assignees) is Self
          (
            COALESCE(ta.role, 'member') = 'creator'
            AND NOT EXISTS (
              SELECT 1
              FROM task_assignees ta_other
              WHERE ta_other.task_id = t.id AND ta_other.user_id != $1
            )
          )
       )
     ORDER BY t.created_at DESC`,
    [userId]
  );

  // Self tasks with no assignees: creator-only tasks (no task_assignees rows) -> show under Self
  const selfTasksNoAssigneesResult = await query(
    `SELECT DISTINCT
      t.*,
      true as is_self_task,
      NULL::timestamp as current_user_completed_at,
      NULL::timestamp as current_user_verified_at,
      NULL::timestamp as current_user_accepted_at,
      NULL as assignment_status,
      t.due_date,
      t.reporting_member_id,
      true as is_creator,
      (t.reporting_member_id = $1) as is_reporting_member,
      false as all_members_verified,
      false as all_reporting_members_verified,
      jsonb_build_object('has_accepted', false, 'has_rejected', false, 'assignee_status', NULL) as current_user_status
     FROM tasks t
     WHERE COALESCE(t.created_by, t.creator_id) = $1
      AND COALESCE(t.is_recurring_template, false) = false
      AND COALESCE(t.task_type, 'one_time') != 'recurring_template'
       AND NOT EXISTS (SELECT 1 FROM task_assignees ta_any WHERE ta_any.task_id = t.id)
     ORDER BY t.created_at DESC`,
    [userId]
  );

  // Get assigned tasks:
  // - Current user role = creator AND there is at least one other assignee
  const assignedTasksResult = await query(
    `SELECT 
      t.*,
      false as is_self_task,
      ta_me.completed_at as current_user_completed_at,
      ta_me.verified_at as current_user_verified_at,
      ta_me.accepted_at as current_user_accepted_at,
      CASE WHEN EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id) 
           THEN 'has_assignees' 
           ELSE NULL 
      END as assignment_status,
      (SELECT COUNT(*) FROM task_assignees ta_acc WHERE ta_acc.task_id = t.id AND ta_acc.accepted_at IS NOT NULL) as accepted_assignee_count,
      t.due_date,
      t.reporting_member_id,
      (SELECT COUNT(*) FROM task_assignees ta WHERE ta.task_id = t.id) as assignee_count,
      (SELECT COUNT(*) FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id != $1) as other_assignee_count,
      true as is_creator,
      false as is_reporting_member,
      false as all_members_verified,
      false as all_reporting_members_verified,
      -- Per-user status for overview: has_accepted, has_rejected, assignee_status for display
      (SELECT jsonb_build_object('has_accepted', ta_c.accepted_at IS NOT NULL, 'has_rejected', false, 'assignee_status', ta_c.status)
       FROM task_assignees ta_c WHERE ta_c.task_id = t.id AND ta_c.user_id = $1) as current_user_status
     FROM tasks t
     INNER JOIN task_assignees ta_me ON t.id = ta_me.task_id
     WHERE ta_me.user_id = $1
      AND COALESCE(t.is_recurring_template, false) = false
      AND COALESCE(t.task_type, 'one_time') != 'recurring_template'
       AND (ta_me.status IS NULL OR ta_me.status != 'scheduled')
       AND COALESCE(ta_me.role, 'member') = 'creator'
       AND EXISTS (
         SELECT 1
         FROM task_assignees ta_other
         WHERE ta_other.task_id = t.id AND ta_other.user_id != $1
       )
     ORDER BY t.created_at DESC`,
    [userId]
  );

  // Process self tasks (include creator-with-no-assignees in Self)
  const selfTasks: DashboardTask[] = [
    ...selfTasksResult.rows,
    ...selfTasksNoAssigneesResult.rows,
  ].map((row) => ({
    ...row,
    isSelfTask: true,
    assignmentStatus: row.assignment_status,
    daysUntilDue: calculateDaysUntilDue(row.due_date),
  }));

  // Process assigned tasks
  const assignedTasks: DashboardTask[] = assignedTasksResult.rows.map((row) => ({
    ...row,
    isSelfTask: false,
    assignmentStatus: row.assignment_status,
    daysUntilDue: calculateDaysUntilDue(row.due_date),
  }));

  // Debug logging (remove in production)
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[Dashboard] User ${userId}: Self tasks: ${selfTasks.length}, Assigned tasks: ${assignedTasks.length}`);
    if (selfTasks.length > 0) {
      console.log(`[Dashboard] Self tasks details:`, selfTasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        category: t.category,
        dueDate: t.due_date,
        daysUntilDue: t.daysUntilDue,
        assignmentStatus: t.assignmentStatus
      })));
    }
    if (assignedTasks.length > 0) {
      console.log(`[Dashboard] Assigned tasks details:`, assignedTasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        category: t.category,
        dueDate: t.due_date,
        daysUntilDue: t.daysUntilDue,
        assignmentStatus: t.assignmentStatus
      })));
    }
    if (selfTasks.length === 0 && assignedTasks.length === 0) {
      // Check if user has any tasks at all
      const allTasksCheck = await query(
        `SELECT id, title, status, COALESCE(created_by, creator_id) as creator, 
         (SELECT COUNT(*) FROM task_assignees ta WHERE ta.task_id = tasks.id) as assignee_count
         FROM tasks 
         WHERE COALESCE(created_by, creator_id) = $1 
         LIMIT 5`,
        [userId]
      );
      console.log(`[Dashboard] All tasks for user ${userId}:`, allTasksCheck.rows);
    }
  }

  // Categorize tasks
  const categorizeTasks = (tasks: DashboardTask[]): {
    general: TaskCategoryGroup;
    documentManagement: TaskCategoryGroup;
    complianceManagement: TaskCategoryGroup;
  } => {
    const general: TaskCategoryGroup = {
      scheduled: [],
      todo: [],
      overdue: [],
      dueSoon: [],
      inProgress: [],
      completed: [],
    };

    const documentManagement: TaskCategoryGroup = {
      scheduled: [],
      todo: [],
      overdue: [],
      dueSoon: [],
      inProgress: [],
      completed: [],
    };

    const complianceManagement: TaskCategoryGroup = {
      scheduled: [],
      todo: [],
      overdue: [],
      dueSoon: [],
      inProgress: [],
      completed: [],
    };

    for (const task of tasks) {
      const category = categorizeTask(task, dueSoonDays);
      const taskCategory = task.category || 'general';

      if (taskCategory === 'document_management') {
        documentManagement[category].push(task);
      } else if (taskCategory === 'compliance_management' || task.compliance_id) {
        complianceManagement[category].push(task);
      } else {
        general[category].push(task);
      }
    }

    return { general, documentManagement, complianceManagement };
  };

  const selfCategorized = categorizeTasks(selfTasks);
  const assignedCategorized = categorizeTasks(assignedTasks);
  // Scheduled status is not shown on dashboard (tasks with assignee status 'scheduled' already excluded from query)
  type CategorizedGroups = {
    general: TaskCategoryGroup;
    documentManagement: TaskCategoryGroup;
    complianceManagement: TaskCategoryGroup;
  };
  const clearScheduled = (g: CategorizedGroups): CategorizedGroups => ({
    general: { ...g.general, scheduled: [] },
    documentManagement: { ...g.documentManagement, scheduled: [] },
    complianceManagement: { ...g.complianceManagement, scheduled: [] },
  });
  return {
    selfTasks: clearScheduled(selfCategorized),
    assignedTasks: clearScheduled(assignedCategorized),
  };
};

/**
 * Get task statistics for dashboard
 */
export const getTaskStatistics = async (userId: string): Promise<{
  selfTasksTotal: number;
  selfTasksTodo: number;
  selfTasksOverdue: number;
  selfTasksDueSoon: number;
  selfTasksInProgress: number;
  selfTasksCompleted: number;
  assignedTasksTotal: number;
  assignedTasksTodo: number;
  assignedTasksOverdue: number;
  assignedTasksDueSoon: number;
  assignedTasksInProgress: number;
  assignedTasksCompleted: number;
}> => {
  // Get due soon days from platform settings
  const reminderConfig = await getReminderConfig();
  const dueSoonDays = reminderConfig.dueSoonDays;

  // Self tasks counts: Tasks assigned to user (they need to complete these)
  // todo = pending and current user (assignee) has not accepted yet
  // in_progress = in_progress status OR pending but user has accepted
  const selfTasksCountResult = await query(
    `SELECT 
      COUNT(DISTINCT t.id) as total,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'pending' AND ta.accepted_at IS NULL) as todo,
      COUNT(DISTINCT t.id) FILTER (WHERE t.due_date IS NOT NULL AND (t.status = 'overdue' OR (t.due_date < CURRENT_DATE AND t.status != 'completed'))) as overdue,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'completed' OR (ta.completed_at IS NOT NULL AND ta.verified_at IS NOT NULL)) as completed,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status != 'completed' AND (t.status = 'in_progress' OR (t.status = 'pending' AND ta.accepted_at IS NOT NULL))) as in_progress,
      COUNT(DISTINCT t.id) FILTER (
        WHERE t.status NOT IN ('completed', 'overdue') 
        AND t.due_date IS NOT NULL 
        AND t.due_date >= CURRENT_DATE 
        AND t.due_date <= CURRENT_DATE + INTERVAL '1 day' * $2
      ) as due_soon
     FROM tasks t
     INNER JOIN task_assignees ta ON t.id = ta.task_id
     WHERE ta.user_id = $1
      AND COALESCE(t.is_recurring_template, false) = false
      AND COALESCE(t.task_type, 'one_time') != 'recurring_template'
       AND (ta.status IS NULL OR ta.status != 'scheduled')
       AND (
         COALESCE(ta.role, 'member') <> 'creator'
         OR (
           COALESCE(ta.role, 'member') = 'creator'
           AND NOT EXISTS (
             SELECT 1
             FROM task_assignees ta_other
             WHERE ta_other.task_id = t.id AND ta_other.user_id != $1
           )
         )
       )`,
    [userId, dueSoonDays]
  );

  // Assigned tasks counts: Tasks where user is creator OR reporting member
  // todo = pending and no assignee has accepted yet
  // in_progress = in_progress status OR pending with at least one assignee accepted
  const assignedTasksCountResult = await query(
    `SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE t.status = 'pending' AND (SELECT COUNT(*) FROM task_assignees ta_t WHERE ta_t.task_id = t.id AND ta_t.accepted_at IS NOT NULL) = 0) as todo,
      COUNT(*) FILTER (WHERE t.due_date IS NOT NULL AND (t.status = 'overdue' OR (t.due_date < CURRENT_DATE AND t.status != 'completed'))) as overdue,
      COUNT(*) FILTER (WHERE t.status = 'completed') as completed,
      COUNT(*) FILTER (WHERE t.status != 'completed' AND (t.status = 'in_progress' OR (t.status = 'pending' AND (SELECT COUNT(*) FROM task_assignees ta_i WHERE ta_i.task_id = t.id AND ta_i.accepted_at IS NOT NULL) > 0))) as in_progress,
      COUNT(*) FILTER (
        WHERE t.status NOT IN ('completed', 'overdue') 
        AND t.due_date IS NOT NULL 
        AND t.due_date >= CURRENT_DATE 
        AND t.due_date <= CURRENT_DATE + INTERVAL '1 day' * $2
      ) as due_soon
     FROM tasks t
     INNER JOIN task_assignees ta_me ON t.id = ta_me.task_id
     WHERE ta_me.user_id = $1
      AND COALESCE(t.is_recurring_template, false) = false
      AND COALESCE(t.task_type, 'one_time') != 'recurring_template'
       AND (ta_me.status IS NULL OR ta_me.status != 'scheduled')
       AND COALESCE(ta_me.role, 'member') = 'creator'
       AND EXISTS (
         SELECT 1
         FROM task_assignees ta_other
         WHERE ta_other.task_id = t.id AND ta_other.user_id != $1
       )`,
    [userId, dueSoonDays]
  );

  const selfTasks = selfTasksCountResult.rows[0];
  const assignedTasks = assignedTasksCountResult.rows[0];

  return {
    selfTasksTotal: parseInt(selfTasks.total) || 0,
    selfTasksTodo: parseInt(selfTasks.todo) || 0,
    selfTasksOverdue: parseInt(selfTasks.overdue) || 0,
    selfTasksDueSoon: parseInt(selfTasks.due_soon) || 0,
    selfTasksInProgress: parseInt(selfTasks.in_progress) || 0,
    selfTasksCompleted: parseInt(selfTasks.completed) || 0,
    assignedTasksTotal: parseInt(assignedTasks.total) || 0,
    assignedTasksTodo: parseInt(assignedTasks.todo) || 0,
    assignedTasksOverdue: parseInt(assignedTasks.overdue) || 0,
    assignedTasksDueSoon: parseInt(assignedTasks.due_soon) || 0,
    assignedTasksInProgress: parseInt(assignedTasks.in_progress) || 0,
    assignedTasksCompleted: parseInt(assignedTasks.completed) || 0,
  };
};

