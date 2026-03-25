import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import * as documentTemplateService from '../services/documentTemplateService';

/**
 * Get all document templates
 */
export async function getAllDocumentTemplates(req: AuthRequest, res: Response) {
  try {
    const filters = {
      type: req.query.type as string | undefined,
      status: req.query.status as 'active' | 'inactive' | 'draft' | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
    };

    const result = await documentTemplateService.getAllDocumentTemplates(filters);

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('Error getting document templates:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get document templates',
    });
  }
}

/**
 * Get document template by ID
 */
export async function getDocumentTemplateById(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const template = await documentTemplateService.getDocumentTemplateById(id);

    if (!template) {
      return res.status(404).json({
        success: false,
        error: 'Document template not found',
      });
    }

    res.json({
      success: true,
      data: template,
    });
  } catch (error: any) {
    console.error('Error getting document template:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get document template',
    });
  }
}

/**
 * Create document template
 */
export async function createDocumentTemplate(req: AuthRequest, res: Response) {
  try {
    const {
      name,
      type,
      status,
      headerTemplate,
      bodyTemplate,
      templateSchema,
      autoFillFields,
      pdfSettings,
    } = req.body;

    if (!name || !type || !bodyTemplate) {
      return res.status(400).json({
        success: false,
        error: 'Name, type, and bodyTemplate are required',
      });
    }

    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const template = await documentTemplateService.createDocumentTemplate({
      name,
      type,
      status,
      headerTemplate,
      bodyTemplate,
      templateSchema,
      autoFillFields,
      pdfSettings,
      createdBy: req.user.userId,
    });

    res.status(201).json({
      success: true,
      data: template,
    });
  } catch (error: any) {
    console.error('Error creating document template:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create document template',
    });
  }
}

/**
 * Update document template
 */
export async function updateDocumentTemplate(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const {
      name,
      type,
      status,
      headerTemplate,
      bodyTemplate,
      templateSchema,
      autoFillFields,
      pdfSettings,
    } = req.body;

    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const template = await documentTemplateService.updateDocumentTemplate(
      id,
      {
        name,
        type,
        status,
        headerTemplate,
        bodyTemplate,
        templateSchema,
        autoFillFields,
        pdfSettings,
      },
      req.user.userId
    );

    if (!template) {
      return res.status(404).json({
        success: false,
        error: 'Document template not found',
      });
    }

    res.json({
      success: true,
      data: template,
    });
  } catch (error: any) {
    console.error('Error updating document template:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update document template',
    });
  }
}

/**
 * Delete document template
 */
export async function deleteDocumentTemplate(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const deleted = await documentTemplateService.deleteDocumentTemplate(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Document template not found',
      });
    }

    res.json({
      success: true,
      message: 'Document template deleted successfully',
    });
  } catch (error: any) {
    console.error('Error deleting document template:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete document template',
    });
  }
}

/**
 * Get template version history
 */
export async function getTemplateVersions(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const versions = await documentTemplateService.getTemplateVersions(id);

    res.json({
      success: true,
      data: versions,
    });
  } catch (error: any) {
    console.error('Error getting template versions:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get template versions',
    });
  }
}

/**
 * Get active templates for current user's organization
 */
export async function getActiveTemplates(req: AuthRequest, res: Response) {
  try {
    const organizationId = req.user?.organizationId;
    
    if (!organizationId) {
      return res.status(400).json({
        success: false,
        error: 'Organization ID is required',
      });
    }

    const templates = await documentTemplateService.getActiveTemplatesForOrganization(organizationId);

    res.json({
      success: true,
      data: templates,
    });
  } catch (error: any) {
    console.error('Error getting active templates:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get active templates',
    });
  }
}

/**
 * Generate preview PDF (placeholder - would integrate with PDF library)
 */
export async function generatePreview(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const template = await documentTemplateService.getDocumentTemplateById(id);

    if (!template) {
      return res.status(404).json({
        success: false,
        error: 'Document template not found',
      });
    }

    // TODO: Integrate with PDF generation library (e.g., puppeteer, pdfkit)
    // For now, return template data
    res.json({
      success: true,
      data: {
        template,
        previewUrl: null, // Would be generated PDF URL
        message: 'PDF preview generation not yet implemented',
      },
    });
  } catch (error: any) {
    console.error('Error generating preview:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate preview',
    });
  }
}

