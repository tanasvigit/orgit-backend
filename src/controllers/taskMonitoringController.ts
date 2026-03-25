import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import * as taskMonitoringService from '../services/taskMonitoringService';

/**
 * Get task analytics across organizations
 */
export async function getTaskAnalytics(req: AuthRequest, res: Response) {
  try {
    const filters = {
      organizationId: req.query.organizationId as string | undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
    };

    const stats = await taskMonitoringService.getTaskAnalytics(filters);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: any) {
    console.error('Error getting task analytics:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get task analytics',
    });
  }
}

/**
 * Get organization-specific task analytics
 */
export async function getOrganizationTaskAnalytics(req: AuthRequest, res: Response) {
  try {
    const { organizationId } = req.params;
    const stats = await taskMonitoringService.getOrganizationTaskAnalytics(organizationId);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: any) {
    console.error('Error getting organization task analytics:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get organization task analytics',
    });
  }
}

/**
 * Get overdue tasks
 */
export async function getOverdueTasks(req: AuthRequest, res: Response) {
  try {
    const filters = {
      organizationId: req.query.organizationId as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
    };

    const result = await taskMonitoringService.getOverdueTasks(filters);

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('Error getting overdue tasks:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get overdue tasks',
    });
  }
}

/**
 * Get platform task statistics
 */
export async function getPlatformTaskStatistics(req: AuthRequest, res: Response) {
  try {
    const stats = await taskMonitoringService.getPlatformTaskStatistics();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: any) {
    console.error('Error getting platform task statistics:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get platform task statistics',
    });
  }
}

