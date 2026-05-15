import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import * as organizationStructureService from '../services/organizationStructureService';

async function resolveRequestOrganizationId(req: AuthRequest): Promise<string | null> {
  const organizationIdFromQuery =
    typeof req.query.organization_id === 'string' && req.query.organization_id.trim()
      ? req.query.organization_id.trim()
      : null;

  if (req.user?.role === 'super_admin' && organizationIdFromQuery) {
    return organizationIdFromQuery;
  }

  const fallbackOrganizationId =
    req.user?.organizationId ||
    (typeof req.query.organization_id === 'string' ? req.query.organization_id : null) ||
    null;

  if (!req.user?.userId) {
    return fallbackOrganizationId;
  }

  return organizationStructureService.resolveOrganizationIdForUser(req.user.userId, fallbackOrganizationId);
}

export async function getOrganizationStructureTree(req: AuthRequest, res: Response) {
  try {
    const organizationId = await resolveRequestOrganizationId(req);

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'Organization context is required',
      });
    }

    const includeArchived = req.query.includeArchived === 'true';
    const includeInactive = req.query.includeInactive !== 'false';

    const tree = await organizationStructureService.getOrganizationStructureTree(organizationId, {
      includeArchived,
      includeInactive,
    });

    res.json({
      success: true,
      data: tree,
    });
  } catch (error: any) {
    console.error('Error getting organization structure tree:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to load organization structure',
    });
  }
}

export async function getOrganizationStructureLevels(req: AuthRequest, res: Response) {
  try {
    const organizationId = await resolveRequestOrganizationId(req);

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'Organization context is required',
      });
    }

    const levels = await organizationStructureService.getOrganizationStructureLevels(organizationId);
    res.json({
      success: true,
      data: levels,
    });
  } catch (error: any) {
    console.error('Error getting organization structure levels:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to load organization structure levels',
    });
  }
}

export async function getOrganizationStructureOperationalOptions(req: AuthRequest, res: Response) {
  try {
    const organizationId = await resolveRequestOrganizationId(req);

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'Organization context is required',
      });
    }

    const options = await organizationStructureService.getOrganizationStructureOperationalOptions(organizationId);
    res.json({
      success: true,
      data: options,
    });
  } catch (error: any) {
    console.error('Error getting organization structure options:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to load organization structure options',
    });
  }
}

export async function createOrganizationStructureNode(req: AuthRequest, res: Response) {
  try {
    const organizationId = await resolveRequestOrganizationId(req);
    const actorUserId = req.user?.userId;

    if (!organizationId || !actorUserId) {
      return res.status(403).json({
        success: false,
        error: 'Organization context is required',
      });
    }

    const node = await organizationStructureService.createOrganizationStructureNode(organizationId, actorUserId, {
      relation: req.body.relation,
      referenceNodeId: req.body.referenceNodeId,
      targetLevelNumber: req.body.targetLevelNumber,
      targetSectionLabel: req.body.targetSectionLabel,
      name: req.body.name,
      code: req.body.code,
      description: req.body.description,
      status: req.body.status,
      metaJson: req.body.metaJson,
      createLevelLabel: req.body.createLevelLabel,
      createLevelDefinitionSource: req.body.createLevelDefinitionSource,
      createLevelPresetKey: req.body.createLevelPresetKey,
      createLevelFieldSchema: req.body.createLevelFieldSchema,
      fieldValues: req.body.fieldValues,
    });

    res.status(201).json({
      success: true,
      data: node,
    });
  } catch (error: any) {
    console.error('Error creating organization structure node:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to create organization structure node',
    });
  }
}

export async function updateOrganizationStructureNode(req: AuthRequest, res: Response) {
  try {
    const organizationId = await resolveRequestOrganizationId(req);
    const actorUserId = req.user?.userId;
    const { id } = req.params;

    if (!organizationId || !actorUserId) {
      return res.status(403).json({
        success: false,
        error: 'Organization context is required',
      });
    }

    const node = await organizationStructureService.updateOrganizationStructureNode(organizationId, actorUserId, id, {
      name: req.body.name,
      code: req.body.code,
      description: req.body.description,
      status: req.body.status,
      metaJson: req.body.metaJson,
      fieldValues: req.body.fieldValues,
    });

    res.json({
      success: true,
      data: node,
    });
  } catch (error: any) {
    console.error('Error updating organization structure node:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to update organization structure node',
    });
  }
}

export async function updateOrganizationStructureLevel(req: AuthRequest, res: Response) {
  try {
    const organizationId = await resolveRequestOrganizationId(req);
    const actorUserId = req.user?.userId;
    const { id } = req.params;

    if (!organizationId || !actorUserId) {
      return res.status(403).json({
        success: false,
        error: 'Organization context is required',
      });
    }

    const level = await organizationStructureService.updateOrganizationStructureLevel(organizationId, actorUserId, id, {
      levelLabel: req.body.levelLabel,
      definitionSource: req.body.definitionSource,
      presetKey: req.body.presetKey,
      fieldSchemaJson: req.body.fieldSchemaJson,
      isActive: req.body.isActive,
    });

    res.json({
      success: true,
      data: level,
    });
  } catch (error: any) {
    console.error('Error updating organization structure level:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to update organization structure level',
    });
  }
}

export async function archiveOrganizationStructureNode(req: AuthRequest, res: Response) {
  try {
    const organizationId = await resolveRequestOrganizationId(req);
    const actorUserId = req.user?.userId;
    const { id } = req.params;

    if (!organizationId || !actorUserId) {
      return res.status(403).json({
        success: false,
        error: 'Organization context is required',
      });
    }

    const node = await organizationStructureService.archiveOrganizationStructureNode(organizationId, actorUserId, id);
    res.json({
      success: true,
      data: node,
    });
  } catch (error: any) {
    console.error('Error archiving organization structure node:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to archive organization structure node',
    });
  }
}

export async function deleteOrganizationStructureNode(req: AuthRequest, res: Response) {
  try {
    const organizationId = await resolveRequestOrganizationId(req);
    const actorUserId = req.user?.userId;
    const { id } = req.params;

    if (!organizationId || !actorUserId) {
      return res.status(403).json({
        success: false,
        error: 'Organization context is required',
      });
    }

    await organizationStructureService.deleteOrganizationStructureNode(organizationId, actorUserId, id);
    res.json({
      success: true,
      message: 'Organization structure node deleted successfully',
    });
  } catch (error: any) {
    console.error('Error deleting organization structure node:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to delete organization structure node',
    });
  }
}

export async function getReportingRollups(req: AuthRequest, res: Response) {
  try {
    const organizationId = await resolveRequestOrganizationId(req);

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'Organization context is required',
      });
    }

    const rollups = await organizationStructureService.getReportingRollups(organizationId);
    res.json({
      success: true,
      data: rollups,
    });
  } catch (error: any) {
    console.error('Error getting organization reporting rollups:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to load organization reporting rollups',
    });
  }
}
