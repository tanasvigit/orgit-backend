import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import {
  createDocumentInstance,
  getDocumentInstances,
  getDocumentInstanceById,
  updateDocumentInstance,
  deleteDocumentInstance,
  downloadDocumentInstance,
} from '../services/documentInstanceService';
import { getUserById } from '../services/userService';
import { createNotification } from '../services/notificationService';
import { query } from '../config/database';
import { createTask } from './taskController';
import { uploadDocumentPDFToStorage } from '../services/mediaUploadService';
import { generatePDFFromTemplate } from '../services/pdfGenerationService';

/**
 * Create new document instance from template
 * POST /api/document-instances
 */
export async function createInstance(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You must be part of an organization to create documents. Please contact your administrator to join an organization.',
      });
    }

    const { templateId, filledData, title } = req.body;

    if (!templateId || !filledData || !title) {
      return res.status(400).json({
        success: false,
        error: 'templateId, filledData, and title are required',
      });
    }

    const instance = await createDocumentInstance(
      templateId,
      filledData,
      title,
      userId,
      organizationId,
      req.user?.role || 'employee'
    );

    res.json({
      success: true,
      data: instance,
    });
  } catch (error: any) {
    console.error('Create document instance error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to create document instance',
    });
  }
}

/**
 * Get document instances with filters
 * GET /api/document-instances
 */
export async function getInstances(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const userRole = req.user?.role || 'employee';

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    // Non–super_admin requires a valid organization (UUID); empty string causes DB error
    if (userRole !== 'super_admin' && (!organizationId || organizationId === '')) {
      return res.status(400).json({
        success: false,
        error: 'Organization context required to list document instances.',
      });
    }

    const filters = {
      status: req.query.status as 'draft' | 'final' | 'archived' | undefined,
      templateId: req.query.templateId as string | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
    };

    const result = await getDocumentInstances(
      organizationId ?? '',
      userId,
      userRole,
      filters
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('Get document instances error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get document instances',
    });
  }
}

/**
 * Get document instance by ID
 * GET /api/document-instances/:id
 */
export async function getInstanceById(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const userRole = req.user?.role || 'employee';
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const instance = await getDocumentInstanceById(id, userId, userRole, organizationId);

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: 'Document instance not found',
      });
    }

    res.json({
      success: true,
      data: instance,
    });
  } catch (error: any) {
    console.error('Get document instance error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get document instance',
    });
  }
}

/**
 * Update document instance
 * PUT /api/document-instances/:id
 */
export async function updateInstance(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const { id } = req.params;
    const { filledData, title, status } = req.body;

    // If only status is being updated, use existing filledData
    // Otherwise, filledData is required
    if (!filledData && !status && !title) {
      return res.status(400).json({
        success: false,
        error: 'filledData, title, or status is required',
      });
    }

    // Get existing instance to use its filledData if only status/title is being updated
    let dataToUpdate = filledData;
    if (!filledData) {
      const existing = await getDocumentInstanceById(id, userId || '', req.user?.role || 'employee', req.user?.organizationId);
      if (!existing) {
        return res.status(404).json({
          success: false,
          error: 'Document instance not found',
        });
      }
      dataToUpdate = existing.filledData;
    }

    // Enforce approval flow: cannot mark Final unless Approved
    if (status === 'final') {
      const flow = (dataToUpdate as any)?.approval_flow;
      if (flow?.enabled && flow?.stage !== 'approved') {
        return res.status(400).json({
          success: false,
          error: 'This document requires approval. Only Approved documents can be marked Final.',
        });
      }
    }

    const updated = await updateDocumentInstance(id, dataToUpdate || {}, title, status, userId);

    if (!updated) {
      return res.status(404).json({
        success: false,
        error: 'Document instance not found or cannot be updated',
      });
    }

    res.json({
      success: true,
      data: updated,
    });
  } catch (error: any) {
    console.error('Update document instance error:', error);
    // Return appropriate status code based on error type
    const statusCode = error.message?.includes('not found') ? 404 : 400;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update document instance',
    });
  }
}

/**
 * Mark document as Checked (verification step)
 * POST /api/document-instances/:id/mark-checked
 */
export async function markInstanceChecked(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const userRole = req.user?.role || 'employee';
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const instance = await getDocumentInstanceById(id, userId, userRole, organizationId);
    if (!instance) {
      return res.status(404).json({ success: false, error: 'Document instance not found' });
    }

    const flow = (instance.filledData as any)?.approval_flow;
    if (!flow?.enabled) {
      return res.status(400).json({ success: false, error: 'Approval flow is not enabled for this document.' });
    }
    if (flow.stage !== 'prepared') {
      return res.status(400).json({ success: false, error: `Cannot mark checked from stage: ${flow.stage}` });
    }
    if (flow.checkedByUserId !== userId) {
      return res.status(403).json({ success: false, error: 'You are not assigned as Checked By for this document.' });
    }

    const me = await getUserById(userId);
    const updatedFilledData = {
      ...(instance.filledData || {}),
      checked_by: me?.name || '',
      approval_flow: { ...flow, stage: 'checked' },
    };

    const updated = await updateDocumentInstance(id, updatedFilledData, instance.title, undefined, userId);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Document instance not found' });
    }

    // Notify Approved By user
    try {
      if (flow.approvedByUserId) {
        await createNotification({
          userId: flow.approvedByUserId,
          type: 'document_shared',
          title: `Document pending approval: ${instance.title}`,
          body: 'A document was checked and now requires your approval.',
          relatedEntityType: 'document_instance',
          relatedEntityId: instance.id,
        });
      }
    } catch (e) {
      // ignore
    }

    return res.json({ success: true, data: updated });
  } catch (error: any) {
    console.error('Mark checked error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to mark checked' });
  }
}

/**
 * Mark document as Approved (final approval step)
 * POST /api/document-instances/:id/mark-approved
 */
export async function markInstanceApproved(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const userRole = req.user?.role || 'employee';
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const instance = await getDocumentInstanceById(id, userId, userRole, organizationId);
    if (!instance) {
      return res.status(404).json({ success: false, error: 'Document instance not found' });
    }

    const flow = (instance.filledData as any)?.approval_flow;
    if (!flow?.enabled) {
      return res.status(400).json({ success: false, error: 'Approval flow is not enabled for this document.' });
    }
    if (flow.stage !== 'checked') {
      return res.status(400).json({ success: false, error: `Cannot approve from stage: ${flow.stage}` });
    }
    if (flow.approvedByUserId !== userId) {
      return res.status(403).json({ success: false, error: 'You are not assigned as Approved By for this document.' });
    }

    const me = await getUserById(userId);
    const updatedFilledData = {
      ...(instance.filledData || {}),
      approved_by: me?.name || '',
      approval_flow: { ...flow, stage: 'approved' },
    };

    // Mark as Final when approved
    const updated = await updateDocumentInstance(id, updatedFilledData, instance.title, 'final', userId);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Document instance not found' });
    }

    return res.json({ success: true, data: updated });
  } catch (error: any) {
    console.error('Mark approved error:', error);
    return res.status(400).json({ success: false, error: error.message || 'Failed to mark approved' });
  }
}

/**
 * Create task from document instance (after PDF generated)
 * POST /api/document-instances/:id/create-task
 */
export async function createTaskFromDocument(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const userRole = req.user?.role || 'employee';
    const { id: documentInstanceId } = req.params;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You must be part of an organization to create tasks from documents.',
      });
    }

    const instance = await getDocumentInstanceById(
      documentInstanceId,
      userId,
      userRole,
      organizationId
    );

    if (!instance) {
      return res.status(404).json({
        success: false,
        error: 'Document instance not found',
      });
    }

    // PDF is optional - generate on-demand if missing, but don't block task creation
    if (!instance.pdfUrl || instance.pdfUrl.trim() === '') {
      console.warn(`[createTaskFromDocument] Document ${documentInstanceId} has no PDF. Attempting to generate on-demand...`);
      try {
        const pdfResult = await generatePDFFromTemplate(
          instance.templateId,
          instance.filledData,
          instance.organizationId
        );
        // Update the instance with the generated PDF URL
        await query(`UPDATE document_instances SET pdf_url = $1 WHERE id = $2`, [pdfResult.pdfUrl, documentInstanceId]);
        instance.pdfUrl = pdfResult.pdfUrl;
      } catch (pdfError: any) {
        // Log warning but allow task creation without PDF
        console.warn(`[createTaskFromDocument] Could not generate PDF for document ${documentInstanceId}:`, pdfError.message);
        // Continue without PDF - task can still be created
      }
    }

    // Idempotency: return existing task if one already exists for this document
    const columnCheck = await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'tasks' AND column_name = 'document_instance_id'`
    );
    if (columnCheck.rows.length > 0) {
      const existingTask = await query(
        `SELECT * FROM tasks WHERE document_instance_id = $1 LIMIT 1`,
        [documentInstanceId]
      );
      if (existingTask.rows.length > 0) {
        return res.status(200).json({
          success: true,
          task: existingTask.rows[0],
          message: 'Task already exists for this document',
        });
      }
    }

    const dueDate = new Date();
    dueDate.setHours(23, 59, 59, 999);

    const body = {
      ...req.body,
      title: instance.title,
      description: `Document: ${instance.title}`,
      task_type: 'one_time',
      due_date: dueDate.toISOString(),
      assignee_ids: Array.isArray(req.body?.assignee_ids) ? req.body.assignee_ids : [userId],
      category: 'document_management',
      document_instance_id: documentInstanceId,
    };

    const createTaskReq = { ...req, body } as AuthRequest;
    await createTask(createTaskReq, res);
  } catch (error: any) {
    console.error('Create task from document error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create task from document',
    });
  }
}

/**
 * Delete/archive document instance
 * DELETE /api/document-instances/:id
 */
export async function deleteInstance(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const userRole = req.user?.role || 'employee';
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const deleted = await deleteDocumentInstance(id, userId, userRole, organizationId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Document instance not found',
      });
    }

    res.json({
      success: true,
      message: 'Document instance deleted successfully',
    });
  } catch (error: any) {
    console.error('Delete document instance error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete document instance',
    });
  }
}

/**
 * Download document instance PDF
 * GET /api/document-instances/:id/download
 * Streams PDF bytes to the client (works for local + S3).
 *
 * Note: We intentionally avoid redirecting to a signed URL because XHR/fetch-based
 * downloads (and iframe previews) can fail due to cross-origin/CORS restrictions.
 */
export async function downloadInstance(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const userRole = req.user?.role || 'employee';
    const { id } = req.params;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const pdfBuffer = await downloadDocumentInstance(id, userId, userRole, organizationId);

    if (!pdfBuffer) {
      return res.status(404).json({
        success: false,
        error: 'PDF not found',
      });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="document-${id}.pdf"`);
    res.send(pdfBuffer);
  } catch (error: any) {
    console.error('Download document instance error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to download document',
    });
  }
}

/**
 * Upload PDF for document instance (uses document-pdfs/ prefix)
 * POST /api/document-instances/upload-pdf
 */
export async function uploadDocumentPDF(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You must be part of an organization to upload document PDFs.',
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
      });
    }

    // Only allow PDF files
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({
        success: false,
        error: 'Only PDF files are allowed',
      });
    }

    const { fileUrl, filename } = await uploadDocumentPDFToStorage(req.file);

    res.json({
      success: true,
      data: {
        url: fileUrl,
        filename,
        originalName: req.file.originalname,
        size: req.file.size,
        mimeType: req.file.mimetype,
      },
    });
  } catch (error: any) {
    console.error('Upload document PDF error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload document PDF',
    });
  }
}

