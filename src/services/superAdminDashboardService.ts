import { query } from '../config/database';
import { getTaskAnalytics } from './taskMonitoringService';

export interface DashboardStatistics {
  totalOrganizations: number;
  activeOrganizations: number;
  totalUsers: number;
  activeUsers: number;
  totalTasks: number;
  activeTasks: number;
  completedTasks: number;
  overdueTasks: number;
  recentActivity: Array<{
    type: string;
    description: string;
    timestamp: string;
  }>;
}

/**
 * Get super admin dashboard statistics
 */
export async function getDashboardStatistics(): Promise<DashboardStatistics> {
  // Get organization stats
  const orgResult = await query(
    `SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM user_organizations WHERE organization_id = organizations.id
      )) as active
    FROM organizations`,
    []
  );
  const totalOrganizations = parseInt(orgResult.rows[0].total, 10);
  const activeOrganizations = parseInt(orgResult.rows[0].active, 10);

  // Get user stats
  const userResult = await query(
    `SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'active') as active
    FROM users`,
    []
  );
  const totalUsers = parseInt(userResult.rows[0].total, 10);
  const activeUsers = parseInt(userResult.rows[0].active, 10);

  // Get task stats
  const taskStats = await getTaskAnalytics();

  // Get recent activity (last 10 activities)
  const activityResult = await query(
    `SELECT 
      'organization_created' as type,
      'Organization "' || name || '" created' as description,
      created_at as timestamp
    FROM organizations
    UNION ALL
    SELECT 
      'user_registered' as type,
      'User "' || name || '" registered' as description,
      created_at as timestamp
    FROM users
    UNION ALL
    SELECT 
      'task_created' as type,
      'Task "' || title || '" created' as description,
      created_at as timestamp
    FROM tasks
    ORDER BY timestamp DESC
    LIMIT 10`,
    []
  );

  const recentActivity = activityResult.rows.map((row: any) => ({
    type: row.type,
    description: row.description,
    timestamp: row.timestamp.toISOString(),
  }));

  return {
    totalOrganizations,
    activeOrganizations,
    totalUsers,
    activeUsers,
    totalTasks: taskStats.totalTasks,
    activeTasks: taskStats.activeTasks,
    completedTasks: taskStats.completedTasks,
    overdueTasks: taskStats.overdueTasks,
    recentActivity,
  };
}

/**
 * Get organization metrics
 */
export async function getOrganizationMetrics() {
  const result = await query(
    `SELECT 
      o.id,
      o.name,
      COUNT(DISTINCT uo.user_id) as user_count,
      COUNT(DISTINCT t.id) as task_count,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'completed') as completed_tasks,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'overdue') as overdue_tasks
    FROM organizations o
    LEFT JOIN user_organizations uo ON o.id = uo.organization_id
    LEFT JOIN tasks t ON o.id = t.organization_id
    GROUP BY o.id, o.name
    ORDER BY o.created_at DESC`,
    []
  );

  return result.rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    userCount: parseInt(row.user_count, 10),
    taskCount: parseInt(row.task_count, 10),
    completedTasks: parseInt(row.completed_tasks, 10),
    overdueTasks: parseInt(row.overdue_tasks, 10),
  }));
}

/**
 * Get user metrics
 */
export async function getUserMetrics() {
  const result = await query(
    `SELECT 
      role,
      status,
      COUNT(*) as count
    FROM users
    GROUP BY role, status
    ORDER BY role, status`,
    []
  );

  return result.rows.map((row: any) => ({
    role: row.role,
    status: row.status,
    count: parseInt(row.count, 10),
  }));
}

/**
 * Get task metrics
 */
export async function getTaskMetrics() {
  return getTaskAnalytics();
}

