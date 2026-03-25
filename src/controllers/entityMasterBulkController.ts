import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import { query } from '../config/database';
import * as entityMasterBulkService from '../services/entityMasterBulkService';
import * as entityMasterBulkQueueService from '../services/entityMasterBulkQueueService';

/**
 * GET /api/admin/entity-master/template
 * Returns Excel template. Query ?only=organisation returns single-sheet Entity Master template.
 */
export async function getTemplate(req: AuthRequest, res: Response): Promise<void> {
  try {
    const only = req.query?.only as string;
    const onlyOrganisation = only === 'organisation';
    const onlyEmployees = only === 'employees';
    const onlyServiceList = only === 'service-list';
    const onlyEntityList = only === 'entity-list';
    console.log('[EntityMasterTemplate] GET template', { only, onlyOrganisation, onlyEmployees, onlyServiceList, onlyEntityList });

    let buffer: Buffer;
    let filename: string;
    if (onlyOrganisation) {
      buffer = await entityMasterBulkService.buildEntityMasterOnlyTemplate();
      filename = 'Entity_Master_template.xlsx';
    } else if (onlyEmployees) {
      buffer = await entityMasterBulkService.buildEmployeeOnlyTemplate();
      filename = 'Employee_template.xlsx';
    } else if (onlyServiceList) {
      buffer = await entityMasterBulkService.buildServiceListOnlyTemplate();
      filename = 'Service_List_template.xlsx';
    } else if (onlyEntityList) {
      buffer = await entityMasterBulkService.buildEntityListOnlyTemplate();
      filename = 'Entity_List_template.xlsx';
    } else {
      buffer = await entityMasterBulkService.buildTemplateWorkbook();
      filename = 'OrgIt_Settings_template.xlsx';
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
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
