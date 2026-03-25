import { Request, Response } from 'express';
import { getMentionableTasks } from '../services/taskMentionService';

/**
 * Get tasks that can be mentioned
 */
export const getMentionableTasksHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const tasks = await getMentionableTasks(userId);

    res.json({
      success: true,
      data: tasks,
    });
  } catch (error: any) {
    console.error('Get mentionable tasks error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get mentionable tasks',
    });
  }
};

