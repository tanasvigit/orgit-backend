import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import * as platformSettingsService from '../services/platformSettingsService';

/**
 * Get all platform settings
 */
export async function getAllSettings(req: AuthRequest, res: Response) {
  try {
    const settings = await platformSettingsService.getPlatformSettings();
    res.json({
      success: true,
      data: settings,
    });
  } catch (error: any) {
    console.error('Error getting platform settings:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get platform settings',
    });
  }
}

/**
 * Get specific setting by key
 */
export async function getSetting(req: AuthRequest, res: Response) {
  try {
    const { key } = req.params;
    const setting = await platformSettingsService.getSetting(key);

    if (!setting) {
      return res.status(404).json({
        success: false,
        error: 'Setting not found',
      });
    }

    res.json({
      success: true,
      data: setting,
    });
  } catch (error: any) {
    console.error('Error getting setting:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get setting',
    });
  }
}

/**
 * Update auto-escalation configuration
 */
export async function updateAutoEscalation(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const config = req.body;
    await platformSettingsService.updateAutoEscalationConfig(config, req.user.userId);

    res.json({
      success: true,
      message: 'Auto-escalation configuration updated successfully',
      data: config,
    });
  } catch (error: any) {
    console.error('Error updating auto-escalation config:', error);
    const statusCode = error.message.includes('must be between') ? 400 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update auto-escalation configuration',
    });
  }
}

/**
 * Update reminder configuration
 */
export async function updateReminder(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const config = req.body;
    await platformSettingsService.updateReminderConfig(config, req.user.userId);

    res.json({
      success: true,
      message: 'Reminder configuration updated successfully',
      data: config,
    });
  } catch (error: any) {
    console.error('Error updating reminder config:', error);
    const statusCode = error.message.includes('must be between') || error.message.includes('must be a') ? 400 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update reminder configuration',
    });
  }
}

/**
 * Update recurring task settings
 */
export async function updateRecurringTasks(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const settings = req.body;
    await platformSettingsService.updateRecurringTaskSettings(settings, req.user.userId);

    res.json({
      success: true,
      message: 'Recurring task settings updated successfully',
      data: settings,
    });
  } catch (error: any) {
    console.error('Error updating recurring task settings:', error);
    const statusCode = error.message.includes('Invalid') || error.message.includes('must be') ? 400 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update recurring task settings',
    });
  }
}

/**
 * Update system settings
 */
export async function updateSystemSettings(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const settings = req.body;
    await platformSettingsService.updateSystemSettings(settings, req.user.userId);

    res.json({
      success: true,
      message: 'System settings updated successfully',
      data: settings,
    });
  } catch (error: any) {
    console.error('Error updating system settings:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update system settings',
    });
  }
}

