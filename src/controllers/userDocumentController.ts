import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import {
  createUserDocument,
  getUserDocumentsForUser,
  getUserDocumentById,
  getUserDocumentDownloadUrl,
  downloadUserDocument,
  deleteUserDocument,
} from '../services/userDocumentService';
import { uploadDocumentPDFToStorage } from '../services/mediaUploadService';
import { query } from '../config/database';
import { createTask } from './taskController';

export async function listUserDocuments(req: AuthRequest, res: Response) {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You must be part of an organization to list documents.',
      });
    }
    const filters = {
      templateId: req.query.templateId as string | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
    };
    const result = await getUserDocumentsForUser(organizationId, filters);
    return res.json({
      success: true,
      data: {
        documents: result.documents,
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    });
  } catch (error: any) {
    console.error('List user documents error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to list documents',
    });
  }
}

export async function createUserDoc(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You must be part of an organization to create documents.',
      });
    }
    const { templateId, title, pdfUrl } = req.body;
    if (!templateId || !title || !pdfUrl) {
      return res.status(400).json({
        success: false,
        error: 'templateId, title, and pdfUrl are required',
      });
    }
    const document = await createUserDocument({
      templateId,
      organizationId,
      title: String(title).trim(),
      pdfUrl: String(pdfUrl).trim(),
      userId,
    });
    return res.status(201).json({ success: true, data: document });
  } catch (error: any) {
    console.error('Create user document error:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'Failed to create document',
    });
  }
}

export async function getUserDoc(req: AuthRequest, res: Response) {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You must be part of an organization to view documents.',
      });
    }
    const { id } = req.params;
    const document = await getUserDocumentById(id, organizationId);
    if (!document) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }
    return res.json({ success: true, data: document });
  } catch (error: any) {
    console.error('Get user document error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get document',
    });
  }
}

export async function downloadUserDoc(req: AuthRequest, res: Response) {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You must be part of an organization to download documents.',
      });
    }
    const { id } = req.params;
    const buffer = await downloadUserDocument(id, organizationId);
    if (!buffer) {
      return res.status(404).json({ success: false, error: 'Document not found or PDF unavailable' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="document.pdf"');
    return res.send(buffer);
  } catch (error: any) {
    console.error('Download user document error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to download document',
    });
  }
}

export async function uploadUserDocumentPDF(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You must be part of an organization to upload document PDFs.',
      });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ success: false, error: 'Only PDF files are allowed' });
    }
    const { fileUrl, filename } = await uploadDocumentPDFToStorage(req.file);
    return res.json({
      success: true,
      data: { url: fileUrl, filename, originalName: req.file.originalname, size: req.file.size, mimeType: req.file.mimetype },
    });
  } catch (error: any) {
    console.error('Upload user document PDF error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload PDF',
    });
  }
}

export async function createTaskFromUserDocument(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const { id: documentId } = req.params;

    if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You must be part of an organization to create tasks from documents.',
      });
    }

    const document = await getUserDocumentById(documentId, organizationId);
    if (!document) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    const columnCheck = await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'tasks' AND column_name = 'document_id'`
    );
    const hasDocumentId = columnCheck.rows.length > 0;

    if (hasDocumentId) {
      const existing = await query(`SELECT * FROM tasks WHERE document_id = $1 LIMIT 1`, [documentId]);
      if (existing.rows.length > 0) {
        return res.status(200).json({
          success: true,
          task: existing.rows[0],
          message: 'Task already exists for this document',
        });
      }
    }

    const dueDate = new Date();
    dueDate.setHours(23, 59, 59, 999);

    const body = {
      ...req.body,
      title: document.title,
      description: `Document: ${document.title}`,
      task_type: 'one_time',
      due_date: dueDate.toISOString(),
      assignee_ids: Array.isArray(req.body?.assignee_ids) ? req.body.assignee_ids : [userId],
      category: 'document_management',
      document_id: documentId,
    };

    const createTaskReq = { ...req, body } as AuthRequest;
    await createTask(createTaskReq, res);
  } catch (error: any) {
    console.error('Create task from user document error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to create task',
    });
  }
}

export async function deleteUserDoc(req: AuthRequest, res: Response) {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You must be part of an organization to delete documents.',
      });
    }
    const { id } = req.params;
    const deleted = await deleteUserDocument(id, organizationId);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }
    return res.json({ success: true, message: 'Document deleted successfully' });
  } catch (error: any) {
    console.error('Delete user document error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete document',
    });
  }
}
