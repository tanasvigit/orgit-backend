import { Request, Response } from 'express';
import { getDashboardData, getTaskStatistics } from '../services/dashboardService';

/**
 * Get dashboard data
 */
export const getDashboard = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    // dueSoonDays now comes from platform settings automatically
    const dashboardData = await getDashboardData(userId);

    res.json({
      success: true,
      data: dashboardData,
    });
  } catch (error: any) {
    console.error('Get dashboard error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get dashboard data',
    });
  }
};

/**
 * Get task statistics
 */
export const getStatistics = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const statistics = await getTaskStatistics(userId);

    res.json({
      success: true,
      data: statistics,
    });
  } catch (error: any) {
    console.error('Get statistics error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get statistics',
    });
  }
};

