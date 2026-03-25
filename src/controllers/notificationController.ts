import { Request, Response } from 'express';
import {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
} from '../services/notificationService';

/**
 * Get user notifications
 */
export const getNotifications = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const limit = parseInt(req.query.limit as string) || 50;
    const unreadOnly = req.query.unreadOnly === 'true';

    const notifications = await getUserNotifications(userId, limit, unreadOnly);

    res.json({
      success: true,
      data: notifications,
    });
  } catch (error: any) {
    console.error('Get notifications error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get notifications',
    });
  }
};

/**
 * Mark notification as read
 */
export const markAsReadHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { notificationId } = req.params;

    await markNotificationAsRead(notificationId, userId);

    res.json({
      success: true,
      message: 'Notification marked as read',
    });
  } catch (error: any) {
    console.error('Mark notification as read error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to mark notification as read',
    });
  }
};

/**
 * Mark all notifications as read
 */
export const markAllAsReadHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;

    await markAllNotificationsAsRead(userId);

    res.json({
      success: true,
      message: 'All notifications marked as read',
    });
  } catch (error: any) {
    console.error('Mark all notifications as read error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to mark all notifications as read',
    });
  }
};

/**
 * Delete notification
 */
export const deleteNotificationHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { notificationId } = req.params;

    await deleteNotification(notificationId, userId);

    res.json({
      success: true,
      message: 'Notification deleted',
    });
  } catch (error: any) {
    console.error('Delete notification error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete notification',
    });
  }
};

