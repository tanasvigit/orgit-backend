import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import {
  getDocumentManagementSettings,
  upsertDocumentManagementSettings,
} from '../services/documentManagementSettingsService';

/**
 * GET /api/admin/document-management-settings
 */
export async function getSettings(req: AuthRequest, res: Response) {
  try {
    const user = req.user;
    if (!user?.userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    if (!user.organizationId) {
      return res.status(403).json({ success: false, error: 'Organization required' });
    }

    const settings = await getDocumentManagementSettings(user.organizationId);
    return res.json({ success: true, data: settings });
  } catch (error: any) {
    console.error('Get document management settings error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
}

/**
 * PUT /api/admin/document-management-settings
 */
export async function updateSettings(req: AuthRequest, res: Response) {
  try {
    const user = req.user;
    if (!user?.userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    if (!user.organizationId) {
      return res.status(403).json({ success: false, error: 'Organization required' });
    }

    const { enabled, checkedByUserId, approvedByUserId } = req.body || {};
    const settings = await upsertDocumentManagementSettings({
      organizationId: user.organizationId,
      updatedByUserId: user.userId,
      settings: {
        enabled: !!enabled,
        checkedByUserId: checkedByUserId || null,
        approvedByUserId: approvedByUserId || null,
      },
    });

    return res.json({ success: true, data: settings });
  } catch (error: any) {
    console.error('Update document management settings error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal server error' });
  }
}

