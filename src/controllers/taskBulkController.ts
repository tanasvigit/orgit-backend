import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import { query } from '../config/database';
import * as taskBulkService from '../services/taskBulkService';
import * as taskBulkQueueService from '../services/taskBulkQueueService';

/**
 * GET /api/admin/tasks/bulk/template
 * Returns Excel template for tasks bulk upload.
 */
export async function getTemplate(req: AuthRequest, res: Response): Promise<void> {
  try {
    const buffer = await taskBulkService.buildTaskTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Task_template.xlsx');
    res.send(Buffer.from(buffer));
  } catch (error: any) {
    console.error('Error generating task template:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate template',
    });
  }
}

/**
 * POST /api/admin/tasks/bulk/upload
 * Accepts multipart file (.xlsx). Enqueues rows for processing; returns uploadId.
 */
export async function upload(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user) {
      return void res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const file = (req as any).file;
    if (!file || !file.buffer) {
      return void res.status(400).json({
        success: false,
        error: 'No file uploaded. Please upload an Excel (.xlsx) file.',
      });
    }
    const ext = (file.originalname || '').toLowerCase();
    if (!ext.endsWith('.xlsx') && !ext.endsWith('.xls')) {
      return void res.status(400).json({
        success: false,
        error: 'Invalid file type. Please upload an Excel file (.xlsx).',
      });
    }
    const userId = req.user.userId;
    let organizationId = req.user.organizationId || null;
    if (!organizationId) {
      const orgResult = await query(
        'SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1',
        [userId]
      );
      organizationId = orgResult.rows[0]?.organization_id || null;
    }
    if (!organizationId) {
      return void res.status(400).json({
        success: false,
        error: 'Organization ID is required. User must be associated with an organization.',
      });
    }

    const result = await taskBulkQueueService.enqueueTaskBulkUpload(
      file.buffer,
      file.originalname || 'upload.xlsx',
      userId,
      organizationId
    );

    res.json({
      success: true,
      data: {
        uploadId: result.uploadId,
        totalRows: result.totalRows,
        status: result.status,
        ...(result.validationErrors && result.validationErrors.length > 0
          ? { validationErrors: result.validationErrors }
          : {}),
      },
    });
  } catch (error: any) {
    console.error('Error uploading task bulk file:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process upload',
    });
  }
}

/**
 * GET /api/admin/tasks/bulk/status/:uploadId
 * Returns progress and status for a task bulk upload. Scoped to user's organization.
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

    const status = await taskBulkQueueService.getUploadStatus(uploadId, organizationId);
    if (!status) {
      return void res.status(404).json({ success: false, error: 'Upload not found' });
    }

    res.json({
      success: true,
      data: {
        totalRows: status.totalRows,
        status: status.status,
        processedCount: status.processedCount,
        failedCount: status.failedCount,
        createdAt: status.createdAt,
        updatedAt: status.updatedAt,
        completedAt: status.completedAt,
        ...(status.errors && status.errors.length > 0 ? { errors: status.errors } : {}),
      },
    });
  } catch (error: any) {
    console.error('Error getting task bulk status:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get status',
    });
  }
}
