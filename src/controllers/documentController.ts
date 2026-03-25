import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import * as documentService from '../services/documentService';

export async function uploadDocument(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const file = (req as any).file as Express.Multer.File | undefined;
    if (!file) {
      return res.status(400).json({ success: false, error: 'File is required' });
    }

    const { title, category, description } = req.body;

    if (!title) {
      return res.status(400).json({
        success: false,
        error: 'Title is required',
      });
    }

    const document = await documentService.createDocument(
      { title, category, description },
      file,
      {
        id: req.user.userId,
        role: req.user.role,
        organizationId: req.user.organizationId,
      }
    );

    return res.status(201).json({
      success: true,
      data: document,
    });
  } catch (error: any) {
    console.error('Error uploading document:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload document',
    });
  }
}

export async function getDocuments(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const documents = await documentService.getDocumentsForUser({
      id: req.user.userId,
      role: req.user.role,
      organizationId: req.user.organizationId,
    });

    return res.json({
      success: true,
      data: documents,
    });
  } catch (error: any) {
    console.error('Error getting documents:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get documents',
    });
  }
}

export async function getDocumentById(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { id } = req.params;

    const document = await documentService.getDocumentById(id, {
      id: req.user.userId,
      role: req.user.role,
      organizationId: req.user.organizationId,
    });

    if (!document) {
      return res.status(404).json({
        success: false,
        error: 'Document not found or access denied',
      });
    }

    return res.json({
      success: true,
      data: document,
    });
  } catch (error: any) {
    console.error('Error getting document:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get document',
    });
  }
}

export async function updateDocument(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { id } = req.params;
    const { title, category, description } = req.body;

    const updated = await documentService.updateDocumentMetadata(
      id,
      { title, category, description },
      {
        id: req.user.userId,
        role: req.user.role,
        organizationId: req.user.organizationId,
      }
    );

    if (!updated) {
      return res.status(404).json({
        success: false,
        error: 'Document not found or access denied',
      });
    }

    return res.json({
      success: true,
      data: updated,
    });
  } catch (error: any) {
    console.error('Error updating document:', error);
    const statusCode = error.message.includes('only') || error.message.includes('cannot')
      ? 403
      : 500;
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update document',
    });
  }
}

export async function updateDocumentStatus(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { id } = req.params;
    const { status } = req.body as { status: 'ACTIVE' | 'INACTIVE' };

    if (status !== 'ACTIVE' && status !== 'INACTIVE') {
      return res.status(400).json({
        success: false,
        error: 'Invalid status value',
      });
    }

    const updated = await documentService.updateDocumentStatus(
      id,
      status,
      {
        id: req.user.userId,
        role: req.user.role,
        organizationId: req.user.organizationId,
      }
    );

    if (!updated) {
      return res.status(404).json({
        success: false,
        error: 'Document not found or access denied',
      });
    }

    return res.json({
      success: true,
      data: updated,
    });
  } catch (error: any) {
    console.error('Error updating document status:', error);
    const statusCode = error.message.includes('only') || error.message.includes('cannot')
      ? 403
      : 500;
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update document status',
    });
  }
}

export async function deleteDocument(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { id } = req.params;

    const deleted = await documentService.softDeleteDocument(
      id,
      {
        id: req.user.userId,
        role: req.user.role,
        organizationId: req.user.organizationId,
      }
    );

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Document not found or access denied',
      });
    }

    return res.json({
      success: true,
      message: 'Document deleted successfully',
    });
  } catch (error: any) {
    console.error('Error deleting document:', error);
    const statusCode = error.message.includes('only') || error.message.includes('cannot')
      ? 403
      : 500;
    return res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to delete document',
    });
  }
}


