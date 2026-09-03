import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import { query } from '../config/database';
import * as entityMasterBulkService from '../services/entityMasterBulkService';
import * as entityMasterBulkQueueService from '../services/entityMasterBulkQueueService';

const MASTER_BULK_FILENAME = 'OrgIt_Master_Bulk.xlsx';
const DEPRECATED_ONLY_MSG =
  'Partial Excel templates are no longer available. Download the master bulk workbook from Settings.';

/**
 * GET /api/admin/entity-master/template
 * Returns the unified OrgIt Master Bulk Excel workbook.
 */
export async function getTemplate(req: AuthRequest, res: Response): Promise<void> {
  try {
    const only = req.query?.only as string | undefined;
    if (only) {
      return void res.status(400).json({
        success: false,
        error: DEPRECATED_ONLY_MSG,
      });
    }

    let organizationId = req.user?.organizationId || null;
    if (!organizationId && req.user?.userId) {
      const orgResult = await query(
        'SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1',
        [req.user.userId]
      );
      organizationId = orgResult.rows[0]?.organization_id || null;
    }
    if (!organizationId) {
      return void res.status(400).json({
        success: false,
        error: 'Organization ID is required to generate templates.',
      });
    }

    const buffer = await entityMasterBulkService.buildTemplateWorkbook(organizationId);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${MASTER_BULK_FILENAME}`);
    res.send(Buffer.from(buffer));
  } catch (error: any) {
    console.error('Error generating entity master template:', error);
    return void res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate template',
    });
  }
}

/**
 * POST /api/admin/entity-master/upload
 * Accepts multipart file (.xlsx). Enqueues for processing; returns uploadId.
 */
export async function upload(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const file = (req as any).file;
    if (!file || !file.buffer) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Please upload an Excel (.xlsx) file.',
      });
    }
    const ext = (file.originalname || '').toLowerCase();
    if (!ext.endsWith('.xlsx') && !ext.endsWith('.xls')) {
      return res.status(400).json({
        success: false,
        error: 'Invalid file type. Please upload an Excel file (.xlsx).',
      });
    }
    const userId = req.user.userId;
    let userOrganizationId = req.user.organizationId || null;
    if (!userOrganizationId) {
      const orgResult = await query(
        'SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      userOrganizationId = orgResult.rows[0]?.organization_id || null;
    }
    const isSuperAdmin = req.user.role === 'super_admin';
    if (!userOrganizationId) {
      return res.status(400).json({
        success: false,
        error: 'Organization ID is required. User must be associated with an organization.',
      });
    }

    console.log('[EntityMasterUpload] Enqueue', {
      fileSize: file.buffer?.length,
      userId,
      userOrganizationId,
      isSuperAdmin,
    });

    const result = await entityMasterBulkQueueService.enqueueEntityMasterBulkUpload(
      file.buffer,
      file.originalname || 'upload.xlsx',
      userId,
      userOrganizationId,
      isSuperAdmin
    );

    return void res.json({
      success: true,
      data: {
        uploadId: result.uploadId,
        status: result.status,
      },
    });
  } catch (error: any) {
    console.error('Error uploading entity master file:', error);
    return void res.status(500).json({
      success: false,
      error: error.message || 'Failed to process upload',
    });
  }
}

/**
 * GET /api/admin/entity-master/status/:uploadId
 * Returns progress and status for an entity master bulk upload. Scoped to user's organization.
 */
export async function getStatus(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return void res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    let organizationId = req.user.organizationId || null;
    if (!organizationId) {
      const orgResult = await query(
        'SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1',
        [req.user.userId]
      );
      organizationId = orgResult.rows[0]?.organization_id || null;
    }
    if (!organizationId) {
      return void res.status(400).json({
        success: false,
        error: 'Organization ID is required.',
      });
    }

    const uploadId = req.params.uploadId;
    if (!uploadId) {
      return void res.status(400).json({ success: false, error: 'uploadId is required' });
    }

    const status = await entityMasterBulkQueueService.getUploadStatus(uploadId, organizationId);
    if (!status) {
      return void res.status(404).json({ success: false, error: 'Upload not found' });
    }

    res.json({
      success: true,
      data: {
        status: status.status,
        processedCount: status.processedCount,
        failedCount: status.failedCount,
        createdAt: status.createdAt,
        updatedAt: status.updatedAt,
        completedAt: status.completedAt,
        ...(status.totalRows != null ? { totalRows: status.totalRows } : {}),
        ...(status.uploadType ? { uploadType: status.uploadType } : {}),
        ...(status.filename ? { filename: status.filename } : {}),
        ...(status.phase ? { phase: status.phase } : {}),
        ...(status.tasksProgress ? { tasksProgress: status.tasksProgress } : {}),
        ...(status.summary ? { summary: status.summary } : {}),
        ...(status.errors && status.errors.length > 0 ? { errors: status.errors } : {}),
      },
    });
  } catch (error: any) {
    console.error('Error getting entity master bulk status:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get status',
    });
  }
}

/**
 * GET /api/admin/entity-master/uploads
 * Recent bulk uploads for the admin's organization (history + analytics).
 */
export async function listUploads(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return void res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    let organizationId = req.user.organizationId || null;
    if (!organizationId) {
      const orgResult = await query(
        'SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1',
        [req.user.userId]
      );
      organizationId = orgResult.rows[0]?.organization_id || null;
    }
    if (!organizationId) {
      return void res.status(400).json({
        success: false,
        error: 'Organization ID is required.',
      });
    }

    const limitRaw = req.query?.limit;
    const limit = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : 20;
    const uploads = await entityMasterBulkQueueService.listUploads(organizationId, limit);

    res.json({
      success: true,
      data: { uploads },
    });
  } catch (error: any) {
    console.error('Error listing entity master bulk uploads:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to list uploads',
    });
  }
}
