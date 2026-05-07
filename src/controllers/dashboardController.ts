import { Request, Response } from 'express';
import {
  getDashboardData,
  getTaskStatistics,
  getMonthlyCalendarSnapshot,
  getDashboardEventsForUser,
  createDashboardEvent,
} from '../services/dashboardService';

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

export const getMonthlyCalendar = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const now = new Date();
    const rawYear = Number(req.query.year);
    const rawMonth = Number(req.query.month);
    const year = Number.isFinite(rawYear) && rawYear >= 2000 ? rawYear : now.getFullYear();
    const month = Number.isFinite(rawMonth) && rawMonth >= 1 && rawMonth <= 12 ? rawMonth : now.getMonth() + 1;
    const view = req.query.view === 'assigned' ? 'assigned' : 'self';
    const data = await getMonthlyCalendarSnapshot(userId, view, year, month);
    res.json({ success: true, data });
  } catch (error: any) {
    console.error('Get monthly calendar error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get monthly calendar',
    });
  }
};

export const getDashboardEvents = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const lookAheadDays = Number(req.query.lookAheadDays || 14);
    const events = await getDashboardEventsForUser(userId, Number.isFinite(lookAheadDays) ? lookAheadDays : 14);
    return res.json({ success: true, data: events });
  } catch (error: any) {
    console.error('Get dashboard events error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to get events' });
  }
};

export const postDashboardEvent = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { title, type, startsAtIso, participantIds, notes } = req.body || {};
    const created = await createDashboardEvent(userId, {
      title,
      type,
      startsAtIso,
      participantIds: Array.isArray(participantIds) ? participantIds : [],
      notes,
    });
    return res.status(201).json({ success: true, data: created });
  } catch (error: any) {
    console.error('Create dashboard event error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to create event' });
  }
};

