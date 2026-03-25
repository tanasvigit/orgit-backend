import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import * as complianceService from '../services/complianceService';
import * as complianceDocumentService from '../services/complianceDocumentService';
import { requireOrganization } from '../middleware/adminMiddleware';

/**
 * Get all compliance items (filtered by role and organization)
 */
export async function getAllComplianceItems(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    // Get user's organization if Admin or Employee
    let userOrganizationId: string | null | undefined = req.user.organizationId;
    if ((req.user.role === 'admin' || req.user.role === 'employee') && !userOrganizationId) {
      // Fetch organization from database
      const { query } = await import('../config/database');
      const orgResult = await query(
        `SELECT organization_id FROM user_organizations 
         WHERE user_id = $1 LIMIT 1`,
        [req.user.userId]
      );
      userOrganizationId = orgResult.rows[0]?.organization_id || null;
    }

    const filters = {
      category: req.query.category as string | undefined,
      status: req.query.status as 'ACTIVE' | 'INACTIVE' | undefined,
      scope: req.query.scope as 'GLOBAL' | 'ORG' | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
    };

    const result = await complianceService.getComplianceForUser(
      req.user.userId,
      req.user.role,
      userOrganizationId,
      filters
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('Error getting compliance items:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get compliance items',
    });
  }
}

/**
 * Get compliance item by ID
 */
export async function getComplianceItemById(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const { id } = req.params;

    // Get user's organization if Admin or Employee
    let userOrganizationId: string | null | undefined = req.user.organizationId;
    if ((req.user.role === 'admin' || req.user.role === 'employee') && !userOrganizationId) {
      const { query } = await import('../config/database');
      const orgResult = await query(
        `SELECT organization_id FROM user_organizations 
         WHERE user_id = $1 LIMIT 1`,
        [req.user.userId]
      );
      userOrganizationId = orgResult.rows[0]?.organization_id || null;
    }

    const item = await complianceService.getComplianceById(
      id,
      req.user.userId,
      req.user.role,
      userOrganizationId
    );

    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Compliance item not found or access denied',
      });
    }

    res.json({
      success: true,
      data: item,
    });
  } catch (error: any) {
    console.error('Error getting compliance item:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get compliance item',
    });
  }
}

/**
 * Create compliance item (with role-based scope assignment)
 */
export async function createComplianceItem(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    // Only Super Admin and Admin can create compliances
    if (req.user.role !== 'super_admin' && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Only Super Admin and Admin can create compliances',
      });
    }

    const {
      title,
      category,
      actName,
      description,
      complianceType,
      frequency,
      effectiveDate,
      status,
      version,
      // Extended fields
      complianceCode,
      applicableLaw,
      sectionRuleReference,
      governingAuthority,
      jurisdictionType,
      stateApplicability,
      industryApplicability,
      entityTypeApplicability,
      applicabilityThreshold,
      mandatoryFlag,
      riskLevel,
      penaltySummary,
      maxPenaltyAmount,
      imprisonmentFlag,
      complianceFrequency,
      dueDateType,
      dueDate,
      dueDateRule,
      gracePeriodDays,
      financialYearApplicable,
      firstTimeCompliance,
      triggerEvent,
      approvalStatus,
      approvedBy,
      scope,
      organizationId,
    } = req.body;

    if (!title || !category || !complianceType) {
      return res.status(400).json({
        success: false,
        error: 'Title, category, and compliance type are required',
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
      if (orgResult.rows.length === 0) {
        return res.status(403).json({
          success: false,
          error: 'Admin must be associated with an organization',
        });
      }
      userOrganizationId = orgResult.rows[0].organization_id;
    }

    const item = await complianceService.createCompliance(
      {
        title,
        category,
        actName,
        description,
        complianceType,
        frequency,
        effectiveDate,
        status,
        version,
        // Extended fields
        complianceCode,
        applicableLaw,
        sectionRuleReference,
        governingAuthority,
        jurisdictionType,
        stateApplicability,
        industryApplicability,
        entityTypeApplicability,
        applicabilityThreshold,
        mandatoryFlag,
        riskLevel,
        penaltySummary,
        maxPenaltyAmount,
        imprisonmentFlag,
        complianceFrequency,
        dueDateType,
        dueDate,
        dueDateRule,
        gracePeriodDays,
        financialYearApplicable,
        firstTimeCompliance,
        triggerEvent,
        approvalStatus,
        approvedBy,
        scope,
        organizationId,
      },
      req.user.userId,
      req.user.role,
      userOrganizationId
    );

    res.status(201).json({
      success: true,
      data: item,
    });
  } catch (error: any) {
    console.error('Error creating compliance item:', error);
    const statusCode = error.message.includes('already exists') ? 400 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to create compliance item',
    });
  }
}

/**
 * Update compliance item (with permission check)
 */
export async function updateComplianceItem(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const { id } = req.params;
    const {
      title,
      category,
      actName,
      description,
      complianceType,
      frequency,
      effectiveDate,
      status,
      version,
      // Extended fields
      complianceCode,
      applicableLaw,
      sectionRuleReference,
      governingAuthority,
      jurisdictionType,
      stateApplicability,
      industryApplicability,
      entityTypeApplicability,
      applicabilityThreshold,
      mandatoryFlag,
      riskLevel,
      penaltySummary,
      maxPenaltyAmount,
      imprisonmentFlag,
      complianceFrequency,
      dueDateType,
      dueDate,
      dueDateRule,
      gracePeriodDays,
      financialYearApplicable,
      firstTimeCompliance,
      triggerEvent,
      approvalStatus,
      approvedBy,
      scope,
      organizationId,
    } = req.body;

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

    const item = await complianceService.updateCompliance(
      id,
      {
        title,
        category,
        actName,
        description,
        complianceType,
        frequency,
        effectiveDate,
        status,
        version,
        // Extended fields
        complianceCode,
        applicableLaw,
        sectionRuleReference,
        governingAuthority,
        jurisdictionType,
        stateApplicability,
        industryApplicability,
        entityTypeApplicability,
        applicabilityThreshold,
        mandatoryFlag,
        riskLevel,
        penaltySummary,
        maxPenaltyAmount,
        imprisonmentFlag,
        complianceFrequency,
        dueDateType,
        dueDate,
        dueDateRule,
        gracePeriodDays,
        financialYearApplicable,
        firstTimeCompliance,
        triggerEvent,
        approvalStatus,
        approvedBy,
        scope,
        organizationId,
      },
      req.user.userId,
      req.user.role,
      userOrganizationId
    );

    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Compliance item not found or access denied',
      });
    }

    res.json({
      success: true,
      data: item,
    });
  } catch (error: any) {
    console.error('Error updating compliance item:', error);
    const statusCode = error.message.includes('permission') || error.message.includes('cannot') ? 403 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update compliance item',
    });
  }
}

/**
 * Update compliance status (activate/deactivate)
 */
export async function updateComplianceStatus(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const { id } = req.params;
    const { status } = req.body;

    if (!status || (status !== 'ACTIVE' && status !== 'INACTIVE')) {
      return res.status(400).json({
        success: false,
        error: 'Status must be ACTIVE or INACTIVE',
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

    const item = await complianceService.updateComplianceStatus(
      id,
      status,
      req.user.userId,
      req.user.role,
      userOrganizationId
    );

    if (!item) {
      return res.status(404).json({
        success: false,
        error: 'Compliance item not found or access denied',
      });
    }

    res.json({
      success: true,
      data: item,
      message: `Compliance ${status === 'ACTIVE' ? 'activated' : 'deactivated'} successfully`,
    });
  } catch (error: any) {
    console.error('Error updating compliance status:', error);
    const statusCode = error.message.includes('permission') || error.message.includes('cannot') ? 403 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to update compliance status',
    });
  }
}

/**
 * Delete compliance item
 */
export async function deleteComplianceItem(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const { id } = req.params;

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

    const deleted = await complianceService.deleteCompliance(
      id,
      req.user.userId,
      req.user.role,
      userOrganizationId
    );

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Compliance item not found or access denied',
      });
    }

    res.json({
      success: true,
      message: 'Compliance item deleted successfully',
    });
  } catch (error: any) {
    console.error('Error deleting compliance item:', error);
    const statusCode = error.message.includes('permission') ? 403 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message || 'Failed to delete compliance item',
    });
  }
}

/**
 * Get compliance categories
 */
export async function getComplianceCategories(req: AuthRequest, res: Response) {
  try {
    const categories = await complianceService.getComplianceCategories();

    res.json({
      success: true,
      data: categories,
    });
  } catch (error: any) {
    console.error('Error getting compliance categories:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get compliance categories',
    });
  }
}

/**
 * Upload compliance document
 */
export async function uploadComplianceDocument(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const { id } = req.params;
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
      });
    }

    // Verify compliance exists and user has access
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

    const compliance = await complianceService.getComplianceById(
      id,
      req.user.userId,
      req.user.role,
      userOrganizationId
    );

    if (!compliance) {
      return res.status(404).json({
        success: false,
        error: 'Compliance not found or access denied',
      });
    }

    const document = await complianceDocumentService.uploadComplianceDocument(
      id,
      file,
      req.user.userId
    );

    res.status(201).json({
      success: true,
      data: document,
    });
  } catch (error: any) {
    console.error('Error uploading compliance document:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to upload document',
    });
  }
}

/**
 * Get compliance documents
 */
export async function getComplianceDocuments(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const { id } = req.params;

    // Verify compliance exists and user has access
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

    const compliance = await complianceService.getComplianceById(
      id,
      req.user.userId,
      req.user.role,
      userOrganizationId
    );

    if (!compliance) {
      return res.status(404).json({
        success: false,
        error: 'Compliance not found or access denied',
      });
    }

    const documents = await complianceDocumentService.getComplianceDocuments(id);

    res.json({
      success: true,
      data: documents,
    });
  } catch (error: any) {
    console.error('Error getting compliance documents:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get documents',
    });
  }
}

/**
 * Delete compliance document
 */
export async function deleteComplianceDocument(req: AuthRequest, res: Response) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const { id, docId } = req.params;

    // Verify compliance exists and user has edit access
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

    const compliance = await complianceService.getComplianceById(
      id,
      req.user.userId,
      req.user.role,
      userOrganizationId
    );

    if (!compliance) {
      return res.status(404).json({
        success: false,
        error: 'Compliance not found or access denied',
      });
    }

    // Check edit permission
    const canEdit = await complianceService.canUserEditCompliance(
      id,
      req.user.userId,
      req.user.role,
      userOrganizationId
    );

    if (!canEdit) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to delete documents for this compliance',
      });
    }

    const deleted = await complianceDocumentService.deleteComplianceDocument(docId, id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Document not found',
      });
    }

    res.json({
      success: true,
      message: 'Document deleted successfully',
    });
  } catch (error: any) {
    console.error('Error deleting compliance document:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete document',
    });
  }
}
