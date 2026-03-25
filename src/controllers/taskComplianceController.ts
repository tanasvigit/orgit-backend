import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import * as taskService from '../services/taskService';

/**
 * Link compliance to task
 */
export async function linkComplianceToTask(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const { taskId } = req.params;
    const { complianceId } = req.body;

    if (!complianceId) {
      return res.status(400).json({
        success: false,
        error: 'Compliance ID is required',
      });
    }

    // Get user's organization if Admin
    let userOrganizationId: string | null | undefined = req.user.organizationId;
    if (req.user.role === 'admin' && !userOrganizationId) {
      const { query } = await import('../config/database');
      const orgResult = await query(
        `SELECT organization_id FROM user_organizations 
         WHERE user_id = $1 LIMIT 1`,
        [req.user.userId]
      );
      userOrganizationId = orgResult.rows[0]?.organization_id || null;
    }

    await taskService.linkComplianceToTask(
      taskId,
      complianceId,
      req.user.userId,
      req.user.role,
      userOrganizationId
    );

    res.json({
      success: true,
      message: 'Compliance linked to task successfully',
    });
  } catch (error: any) {
    console.error('Error linking compliance to task:', error);
    const statusCode = error.message.includes('not found') || error.message.includes('access denied') ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to link compliance to task',
    });
  }
}

/**
 * Unlink compliance from task
 */
export async function unlinkComplianceFromTask(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const { taskId, complianceId } = req.params;

    await taskService.unlinkComplianceFromTask(taskId, complianceId, req.user.userId);

    res.json({
      success: true,
      message: 'Compliance unlinked from task successfully',
    });
  } catch (error: any) {
    console.error('Error unlinking compliance from task:', error);
    const statusCode = error.message.includes('not found') || error.message.includes('Only task creator') ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to unlink compliance from task',
    });
  }
}

/**
 * Get compliances linked to a task
 */
export async function getTaskCompliances(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const { taskId } = req.params;

    // Get user's organization if Admin
    let userOrganizationId: string | null | undefined = req.user.organizationId;
    if (req.user.role === 'admin' && !userOrganizationId) {
      const { query } = await import('../config/database');
      const orgResult = await query(
        `SELECT organization_id FROM user_organizations 
         WHERE user_id = $1 LIMIT 1`,
        [req.user.userId]
      );
      userOrganizationId = orgResult.rows[0]?.organization_id || null;
    }

    const compliances = await taskService.getCompliancesForTask(
      taskId,
      req.user.userId,
      req.user.role,
      userOrganizationId
    );

    res.json({
      success: true,
      data: compliances,
    });
  } catch (error: any) {
    console.error('Error getting task compliances:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get task compliances',
    });
  }
}

