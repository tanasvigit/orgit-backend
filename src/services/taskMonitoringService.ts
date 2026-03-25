import { query } from '../config/database';

export interface TaskMonitoringStats {
  totalTasks: number;
  activeTasks: number;
  completedTasks: number;
  overdueTasks: number;
  pendingTasks: number;
  rejectedTasks: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
}

export interface OrganizationTaskStats {
  organizationId: string;
  organizationName: string;
  totalTasks: number;
  activeTasks: number;
  completedTasks: number;
  overdueTasks: number;
}

/**
 * Get task analytics across all organizations
 */
export async function getTaskAnalytics(filters: {
  organizationId?: string;
  startDate?: string;
  endDate?: string;
} = {}): Promise<TaskMonitoringStats> {
  let whereClause = '';
  const params: any[] = [];
  let paramIndex = 1;

  if (filters.organizationId) {
    whereClause += `WHERE t.organization_id = $${paramIndex}`;
    params.push(filters.organizationId);
    paramIndex++;
  }

  if (filters.startDate) {
    whereClause += whereClause ? ' AND' : 'WHERE';
    whereClause += ` t.created_at >= $${paramIndex}`;
    params.push(filters.startDate);
    paramIndex++;
  }

  if (filters.endDate) {
    whereClause += whereClause ? ' AND' : 'WHERE';
    whereClause += ` t.created_at <= $${paramIndex}`;
    params.push(filters.endDate);
    paramIndex++;
  }

  const result = await query(
    `SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'in_progress') as active,
      COUNT(*) FILTER (WHERE status = 'completed') as completed,
      COUNT(*) FILTER (WHERE status = 'overdue') as overdue,
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE status = 'rejected') as rejected
    FROM tasks t
    ${whereClause}`,
    params
  );

  const row = result.rows[0];

  // Get breakdown by status
  const statusResult = await query(
    `SELECT status, COUNT(*) as count
    FROM tasks t
    ${whereClause}
    GROUP BY status`,
    params
  );

  const byStatus: Record<string, number> = {};
  statusResult.rows.forEach((r: any) => {
    byStatus[r.status] = parseInt(r.count, 10);
  });

  // Get breakdown by category
  const categoryResult = await query(
    `SELECT category, COUNT(*) as count
    FROM tasks t
    ${whereClause}
    GROUP BY category`,
    params
  );

  const byCategory: Record<string, number> = {};
  categoryResult.rows.forEach((r: any) => {
    byCategory[r.category || 'general'] = parseInt(r.count, 10);
  });

  return {
    totalTasks: parseInt(row.total, 10),
    activeTasks: parseInt(row.active, 10),
    completedTasks: parseInt(row.completed, 10),
    overdueTasks: parseInt(row.overdue, 10),
    pendingTasks: parseInt(row.pending, 10),
    rejectedTasks: parseInt(row.rejected, 10),
    byStatus,
    byCategory,
  };
}

/**
 * Get organization-specific task analytics
 */
export async function getOrganizationTaskAnalytics(
  organizationId: string
): Promise<TaskMonitoringStats> {
  return getTaskAnalytics({ organizationId });
}

/**
 * Get overdue tasks across all organizations
 */
export async function getOverdueTasks(filters: {
  organizationId?: string;
  page?: number;
  limit?: number;
} = {}) {
  const { organizationId, page = 1, limit = 20 } = filters;
  const offset = (page - 1) * limit;

  let whereClause = "WHERE t.status = 'overdue'";
  const params: any[] = [];
  let paramIndex = 1;

  if (organizationId) {
    whereClause += ` AND t.organization_id = $${paramIndex}`;
    params.push(organizationId);
    paramIndex++;
  }

  const countResult = await query(
    `SELECT COUNT(*) as total FROM tasks t ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  const result = await query(
    `SELECT 
      t.id, t.title, t.description, t.task_type, t.creator_id, t.organization_id,
      t.start_date, t.target_date, t.due_date, t.frequency, t.specific_weekday,
      t.next_recurrence_date, t.category, t.status, t.escalation_status,
      t.created_at, t.updated_at,
      o.name as organization_name
    FROM tasks t
    INNER JOIN organizations o ON t.organization_id = o.id
    ${whereClause}
    ORDER BY t.due_date ASC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );

  return {
    tasks: result.rows.map(mapTask),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get platform-level task statistics
 */
export async function getPlatformTaskStatistics(): Promise<{
  totalOrganizations: number;
  totalUsers: number;
  totalTasks: number;
  taskStats: TaskMonitoringStats;
  organizationStats: OrganizationTaskStats[];
}> {
  // Get total organizations
  const orgResult = await query(`SELECT COUNT(*) as total FROM organizations`, []);
  const totalOrganizations = parseInt(orgResult.rows[0].total, 10);

  // Get total users
  const userResult = await query(`SELECT COUNT(*) as total FROM users`, []);
  const totalUsers = parseInt(userResult.rows[0].total, 10);

  // Get task stats
  const taskStats = await getTaskAnalytics();

  // Get stats per organization
  const orgStatsResult = await query(
    `SELECT 
      o.id as organization_id,
      o.name as organization_name,
      COUNT(t.id) as total_tasks,
      COUNT(t.id) FILTER (WHERE t.status = 'in_progress') as active_tasks,
      COUNT(t.id) FILTER (WHERE t.status = 'completed') as completed_tasks,
      COUNT(t.id) FILTER (WHERE t.status = 'overdue') as overdue_tasks
    FROM organizations o
    LEFT JOIN tasks t ON o.id = t.organization_id
    GROUP BY o.id, o.name
    ORDER BY total_tasks DESC`,
    []
  );

  const organizationStats: OrganizationTaskStats[] = orgStatsResult.rows.map((row: any) => ({
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    totalTasks: parseInt(row.total_tasks, 10),
    activeTasks: parseInt(row.active_tasks, 10),
    completedTasks: parseInt(row.completed_tasks, 10),
    overdueTasks: parseInt(row.overdue_tasks, 10),
  }));

  return {
    totalOrganizations,
    totalUsers,
    totalTasks: taskStats.totalTasks,
    taskStats,
    organizationStats,
  };
}

/**
 * Map database row to Task type
 */
function mapTask(row: any) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    taskType: row.task_type,
    creatorId: row.creator_id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    startDate: row.start_date ? row.start_date.toISOString() : undefined,
    targetDate: row.target_date ? row.target_date.toISOString() : undefined,
    dueDate: row.due_date ? row.due_date.toISOString() : undefined,
    frequency: row.frequency,
    specificWeekday: row.specific_weekday,
    nextRecurrenceDate: row.next_recurrence_date
      ? row.next_recurrence_date.toISOString()
      : undefined,
    category: row.category,
    status: row.status,
    escalationStatus: row.escalation_status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

