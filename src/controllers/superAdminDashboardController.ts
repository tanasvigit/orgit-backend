import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import * as dashboardService from '../services/superAdminDashboardService';

/**
 * Get dashboard statistics
 */
export async function getDashboardStatistics(req: AuthRequest, res: Response) {
  try {
    const stats = await dashboardService.getDashboardStatistics();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: any) {
    console.error('Error getting dashboard statistics:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get dashboard statistics',
    });
  }
}

/**
 * Get organization metrics
 */
export async function getOrganizationMetrics(req: AuthRequest, res: Response) {
  try {
    const metrics = await dashboardService.getOrganizationMetrics();

    res.json({
      success: true,
      data: metrics,
    });
  } catch (error: any) {
    console.error('Error getting organization metrics:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get organization metrics',
    });
  }
}

/**
 * Get user metrics
 */
export async function getUserMetrics(req: AuthRequest, res: Response) {
  try {
    const metrics = await dashboardService.getUserMetrics();

    res.json({
      success: true,
      data: metrics,
    });
  } catch (error: any) {
    console.error('Error getting user metrics:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get user metrics',
    });
  }
}

/**
 * Get task metrics
 */
export async function getTaskMetrics(req: AuthRequest, res: Response) {
  try {
    const metrics = await dashboardService.getTaskMetrics();

    res.json({
      success: true,
      data: metrics,
    });
  } catch (error: any) {
    console.error('Error getting task metrics:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get task metrics',
    });
  }
}

