import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import { query } from '../config/database';
import {
  getOrganizationStructureTree,
  resolveNodeReference,
  validateOrgFieldValuesForNode,
} from '../services/organizationStructureService';
import { getAssignmentSectionsFromTree } from '../utils/orgStructureAssignmentUtils';
import { clientEntitiesHasOrgFieldValues } from '../utils/orgFieldValuesColumn';
import {
  EMPLOYEE_ORG_NODE_BY_LEVEL_KEY,
  extractOrgNodeByLevel,
  resolvePrimaryFromOrgNodeByLevel,
  stripOrgNodeByLevel,
  validateOrgNodeByLevelChain,
} from '../utils/employeeOrgNodeLevels';

const normalizeNodeId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

async function normalizeClientOrgAssignment(
  organizationId: string,
  orgStructureNodeIdInput: unknown,
  orgFieldValuesInput: unknown
): Promise<{ orgStructureNodeId: string | null; orgFieldValues: Record<string, unknown> }> {
  const rawOrgFieldValues = parseOrgFieldValuesInput(orgFieldValuesInput) || {};
  const orgNodeByLevel = extractOrgNodeByLevel(rawOrgFieldValues);
  const schemaValues = stripOrgNodeByLevel(rawOrgFieldValues);

  let orgStructureNodeId = normalizeNodeId(orgStructureNodeIdInput);

  if (Object.keys(orgNodeByLevel).length > 0) {
    await validateOrgNodeByLevelChain(organizationId, orgNodeByLevel);
  }

  if (!orgStructureNodeId && Object.keys(orgNodeByLevel).length > 0) {
    const tree = await getOrganizationStructureTree(organizationId, {
      includeArchived: false,
      includeInactive: false,
    });
    const assignmentSections = getAssignmentSectionsFromTree(tree, orgNodeByLevel);
    orgStructureNodeId = resolvePrimaryFromOrgNodeByLevel(orgNodeByLevel, assignmentSections, tree.nodes);
  }

  if (orgStructureNodeId) {
    await resolveNodeReference(organizationId, orgStructureNodeId, { activeOnly: true });
  }

  let normalizedSchema: Record<string, unknown> = {};
  if (orgStructureNodeId && Object.keys(schemaValues).length > 0) {
    normalizedSchema = await validateOrgFieldValuesForNode(
      organizationId,
      orgStructureNodeId,
      schemaValues
    );
  }

  const orgFieldValues =
    Object.keys(orgNodeByLevel).length > 0
      ? { ...normalizedSchema, [EMPLOYEE_ORG_NODE_BY_LEVEL_KEY]: orgNodeByLevel }
      : normalizedSchema;

  return { orgStructureNodeId, orgFieldValues };
}

function parseOrgFieldValuesInput(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

function normalizeMobile(mobile: string | undefined): string | null {
  if (mobile == null) return null;
  let normalized = String(mobile).trim();
  if (!normalized) return null;
  normalized = normalized.replace(/\s/g, '');
  const digits = normalized.replace(/\D/g, '');
  if (!digits) return null;
  // 10 digits -> assume India, prefix +91
  if (digits.length === 10) return `+91${digits}`;
  // 12 digits starting with 91 -> +91XXXXXXXXXX
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  // Already has + and reasonable length
  if (normalized.startsWith('+') && digits.length >= 6 && digits.length <= 20) return normalized;
  // Fallback: take last 10 digits and prefix +91
  if (digits.length >= 10 && digits.length <= 20) {
    const last10 = digits.slice(-10);
    return `+91${last10}`;
  }
  return null;
}

/**
 * Admin: List client entities (basic)
 */
export async function getClientEntities(req: AuthRequest, res: Response) {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      return res.status(403).json({ success: false, error: 'You are not associated with any organization' });
    }

    const hasOrgFvColumn = await clientEntitiesHasOrgFieldValues();
    const orgFvSelect = hasOrgFvColumn
      ? 'ce.org_field_values'
      : `'{}'::jsonb AS org_field_values`;

    const result = await query(
      `SELECT 
        ce.id,
        ce.name,
        ce.entity_type,
        ce.org_structure_node_id,
        ce.org_structure_path,
        ce.pan,
        ce.reporting_partner_mobile,
        ce.status,
        ${orgFvSelect},
        n.name as org_structure_node_name,
        n.level_label as org_structure_level_label,
        u.name as reporting_partner_name,
        ce.created_at,
        ce.updated_at
      FROM client_entities ce
      LEFT JOIN organization_structure_nodes n ON ce.org_structure_node_id = n.id
      LEFT JOIN users u ON REPLACE(u.mobile, ' ', '') = REPLACE(ce.reporting_partner_mobile, ' ', '')
      WHERE ce.organization_id = $1
      ORDER BY ce.name ASC`,
      [organizationId]
    );

    return res.json({ success: true, data: result.rows });
  } catch (error: any) {
    console.error('Error getting client entities:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to get client entities' });
  }
}

/**
 * Admin: Create client entity
 */
export async function createClientEntity(req: AuthRequest, res: Response) {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      return res.status(403).json({ success: false, error: 'You are not associated with any organization' });
    }

    const { name, entityType, orgStructureNodeId, pan, reportingPartnerMobile, status, orgFieldValues } =
      req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'Client name is required' });
    }

    const normalizedStatus = status === 'inactive' ? 'inactive' : 'active';
    const normalizedReportingMobile = normalizeMobile(reportingPartnerMobile);
    const orgAssignment = await normalizeClientOrgAssignment(
      organizationId,
      orgStructureNodeId,
      orgFieldValues
    );
    const orgStructureReference = orgAssignment.orgStructureNodeId
      ? await resolveNodeReference(organizationId, orgAssignment.orgStructureNodeId, { activeOnly: true })
      : null;
    const normalizedOrgFieldValues = orgAssignment.orgFieldValues;

    const hasOrgFvColumn = await clientEntitiesHasOrgFieldValues();
    const orgFvReturning = hasOrgFvColumn
      ? 'org_field_values'
      : `'{}'::jsonb AS org_field_values`;

    const result = hasOrgFvColumn
      ? await query(
          `INSERT INTO client_entities (
             organization_id, name, entity_type, org_structure_node_id, org_structure_path,
             pan, reporting_partner_mobile, status, org_field_values, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5::jsonb, NULLIF($6, ''), NULLIF($7, ''), $8, $9::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           RETURNING id, name, entity_type, org_structure_node_id, org_structure_path, pan, reporting_partner_mobile, status, org_field_values, created_at, updated_at`,
          [
            organizationId,
            String(name).trim(),
            entityType || null,
            orgStructureReference?.nodeId || null,
            orgStructureReference?.path ? JSON.stringify(orgStructureReference.path) : null,
            pan ? String(pan).trim().toUpperCase() : null,
            normalizedReportingMobile,
            normalizedStatus,
            JSON.stringify(normalizedOrgFieldValues),
          ]
        )
      : await query(
          `INSERT INTO client_entities (
             organization_id, name, entity_type, org_structure_node_id, org_structure_path,
             pan, reporting_partner_mobile, status, created_at, updated_at
           )
           VALUES ($1, $2, $3, $4, $5::jsonb, NULLIF($6, ''), NULLIF($7, ''), $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           RETURNING id, name, entity_type, org_structure_node_id, org_structure_path, pan, reporting_partner_mobile, status, ${orgFvReturning}, created_at, updated_at`,
          [
            organizationId,
            String(name).trim(),
            entityType || null,
            orgStructureReference?.nodeId || null,
            orgStructureReference?.path ? JSON.stringify(orgStructureReference.path) : null,
            pan ? String(pan).trim().toUpperCase() : null,
            normalizedReportingMobile,
            normalizedStatus,
          ]
        );

    return res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    console.error('Error creating client entity:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to create client entity' });
  }
}

/**
 * Admin: Update client entity
 */
export async function updateClientEntity(req: AuthRequest, res: Response) {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      return res.status(403).json({ success: false, error: 'You are not associated with any organization' });
    }

    const { id } = req.params;
    const { name, entityType, orgStructureNodeId, pan, reportingPartnerMobile, status, orgFieldValues } =
      req.body;

    const normalizedStatus =
      status === 'active' || status === 'inactive'
        ? status
        : undefined;
    const normalizedReportingMobile = normalizeMobile(reportingPartnerMobile);
    const orgStructureNodeIdProvided = orgStructureNodeId !== undefined || orgFieldValues !== undefined;
    const orgFieldValuesProvided = orgFieldValues !== undefined || orgStructureNodeId !== undefined;
    let normalizedOrgFieldValuesJson: string | null = null;
    let orgStructureReference:
      | Awaited<ReturnType<typeof resolveNodeReference>>
      | undefined
      | null = undefined;

    if (orgStructureNodeIdProvided || orgFieldValuesProvided) {
      const existingNodeId =
        orgStructureNodeId !== undefined
          ? normalizeNodeId(orgStructureNodeId)
          : (
              await query(
                'SELECT org_structure_node_id FROM client_entities WHERE id = $1 AND organization_id = $2',
                [id, organizationId]
              )
            ).rows[0]?.org_structure_node_id || null;

      const orgAssignment = await normalizeClientOrgAssignment(
        organizationId,
        orgStructureNodeId !== undefined ? orgStructureNodeId : existingNodeId,
        orgFieldValues
      );
      orgStructureReference = orgAssignment.orgStructureNodeId
        ? await resolveNodeReference(organizationId, orgAssignment.orgStructureNodeId, { activeOnly: true })
        : null;
      normalizedOrgFieldValuesJson = JSON.stringify(orgAssignment.orgFieldValues);
    }

    const hasOrgFvColumn = await clientEntitiesHasOrgFieldValues();
    const orgFvReturning = hasOrgFvColumn
      ? 'org_field_values'
      : `'{}'::jsonb AS org_field_values`;

    const result = hasOrgFvColumn
      ? await query(
          `UPDATE client_entities
           SET name = COALESCE($1, name),
               entity_type = COALESCE($2, entity_type),
               org_structure_node_id = CASE WHEN $3::boolean THEN $4::uuid ELSE org_structure_node_id END,
               org_structure_path = CASE WHEN $3::boolean THEN $5::jsonb ELSE org_structure_path END,
               pan = COALESCE(NULLIF($6, ''), pan),
               reporting_partner_mobile = COALESCE(NULLIF($7, ''), reporting_partner_mobile),
               status = COALESCE($8, status),
               org_field_values = CASE WHEN $9::boolean THEN $10::jsonb ELSE org_field_values END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $11 AND organization_id = $12
           RETURNING id, name, entity_type, org_structure_node_id, org_structure_path, pan, reporting_partner_mobile, status, org_field_values, created_at, updated_at`,
          [
            name ? String(name).trim() : null,
            entityType || null,
            orgStructureNodeIdProvided,
            orgStructureReference?.nodeId || null,
            orgStructureReference?.path ? JSON.stringify(orgStructureReference.path) : null,
            pan ? String(pan).trim().toUpperCase() : null,
            normalizedReportingMobile,
            normalizedStatus || null,
            orgFieldValuesProvided,
            normalizedOrgFieldValuesJson,
            id,
            organizationId,
          ]
        )
      : await query(
          `UPDATE client_entities
           SET name = COALESCE($1, name),
               entity_type = COALESCE($2, entity_type),
               org_structure_node_id = CASE WHEN $3::boolean THEN $4::uuid ELSE org_structure_node_id END,
               org_structure_path = CASE WHEN $3::boolean THEN $5::jsonb ELSE org_structure_path END,
               pan = COALESCE(NULLIF($6, ''), pan),
               reporting_partner_mobile = COALESCE(NULLIF($7, ''), reporting_partner_mobile),
               status = COALESCE($8, status),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $9 AND organization_id = $10
           RETURNING id, name, entity_type, org_structure_node_id, org_structure_path, pan, reporting_partner_mobile, status, ${orgFvReturning}, created_at, updated_at`,
          [
            name ? String(name).trim() : null,
            entityType || null,
            orgStructureNodeIdProvided,
            orgStructureReference?.nodeId || null,
            orgStructureReference?.path ? JSON.stringify(orgStructureReference.path) : null,
            pan ? String(pan).trim().toUpperCase() : null,
            normalizedReportingMobile,
            normalizedStatus || null,
            id,
            organizationId,
          ]
        );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (error: any) {
    console.error('Error updating client entity:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to update client entity' });
  }
}

/**
 * Admin: Delete client entity
 */
export async function deleteClientEntity(req: AuthRequest, res: Response) {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      return res.status(403).json({ success: false, error: 'You are not associated with any organization' });
    }

    const { id } = req.params;
    const result = await query('DELETE FROM client_entities WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    if ((result.rowCount ?? 0) === 0) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }
    return res.json({ success: true, message: 'Client deleted' });
  } catch (error: any) {
    console.error('Error deleting client entity:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to delete client entity' });
  }
}

/**
 * Get task services for the current user's organization (any org member, not only admin).
 * Used for Create Task service dropdown. Response: { services: [...] }
 */
export async function getOrganizationTaskServices(req: AuthRequest, res: Response) {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You must be part of an organization to access task services',
      });
    }

    const type = (req.query.type as string | undefined)?.toLowerCase();
    const taskType = type === 'recurring' || type === 'one_time' ? type : undefined;

    const servicesResult = await query(
      `SELECT id, title, task_type, frequency, rollout_rule
       FROM task_services
       WHERE (organization_id = $1 OR organization_id IS NULL)
         AND is_active = TRUE
         AND ($2::text IS NULL OR task_type = $2)
       ORDER BY task_type ASC, title ASC`,
      [organizationId, taskType ?? null]
    );

    return res.json({ success: true, data: { services: servicesResult.rows } });
  } catch (error: any) {
    console.error('Error getting organization task services:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get task services',
    });
  }
}

/**
 * Admin: Get service matrix for all clients in org.
 * Response: { services: [...], clients: [{... , serviceFrequencies: { [serviceId]: frequency } }] }
 */
export async function getClientServiceMatrix(req: AuthRequest, res: Response) {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      return res.status(403).json({ success: false, error: 'You are not associated with any organization' });
    }

    const type = (req.query.type as string | undefined)?.toLowerCase();
    const taskType = type === 'recurring' || type === 'one_time' ? type : undefined;

    // Services columns (global + org-specific)
    const servicesResult = await query(
      `SELECT id, title, task_type, frequency, rollout_rule
       FROM task_services
       WHERE (organization_id = $1 OR organization_id IS NULL)
         AND is_active = TRUE
         AND ($2::text IS NULL OR task_type = $2)
       ORDER BY task_type ASC, title ASC`,
      [organizationId, taskType ?? null]
    );

    const clientsResult = await query(
      `SELECT 
        ce.id,
        ce.name,
        ce.entity_type,
        ce.org_structure_node_id,
        ce.org_structure_path,
        ce.pan,
        ce.reporting_partner_mobile,
        ce.status,
        n.name as org_structure_node_name,
        n.level_label as org_structure_level_label
       FROM client_entities ce
       LEFT JOIN organization_structure_nodes n ON ce.org_structure_node_id = n.id
       WHERE ce.organization_id = $1
       ORDER BY ce.name ASC`,
      [organizationId]
    );

    // Current assignments (frequency per client per service)
    const assignmentsResult = await query(
      `SELECT ces.client_entity_id, ces.task_service_id, ces.frequency
       FROM client_entity_services ces
       JOIN client_entities ce ON ce.id = ces.client_entity_id
       JOIN task_services ts ON ts.id = ces.task_service_id
       WHERE ce.organization_id = $1
         AND (ts.organization_id = $1 OR ts.organization_id IS NULL)
         AND ts.is_active = TRUE
         AND ($2::text IS NULL OR ts.task_type = $2)`,
      [organizationId, taskType ?? null]
    );

    const byClient: Record<string, Record<string, string>> = {};
    for (const row of assignmentsResult.rows) {
      if (!byClient[row.client_entity_id]) byClient[row.client_entity_id] = {};
      byClient[row.client_entity_id][row.task_service_id] = row.frequency;
    }

    const clients = clientsResult.rows.map((c: any) => ({
      ...c,
      serviceFrequencies: byClient[c.id] || {},
    }));

    return res.json({ success: true, data: { services: servicesResult.rows, clients } });
  } catch (error: any) {
    console.error('Error getting client service matrix:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to get client service matrix' });
  }
}

/**
 * Admin: Bulk update one client's service frequencies.
 * Body: { items: [{ taskServiceId, frequency }] }
 */
export async function upsertClientServices(req: AuthRequest, res: Response) {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      return res.status(403).json({ success: false, error: 'You are not associated with any organization' });
    }

    const { id } = req.params; // client_entity_id
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, error: 'items must be an array' });
    }

    // Ensure client belongs to org
    const clientCheck = await query('SELECT id FROM client_entities WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    if (clientCheck.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }

    for (const item of items) {
      const taskServiceId = item?.taskServiceId || item?.task_service_id;
      const frequency = item?.frequency || 'NA';
      if (!taskServiceId) continue;
      await query(
        `INSERT INTO client_entity_services (client_entity_id, task_service_id, frequency, created_at, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (client_entity_id, task_service_id)
         DO UPDATE SET frequency = EXCLUDED.frequency, updated_at = CURRENT_TIMESTAMP`,
        [id, taskServiceId, frequency]
      );
    }

    return res.json({ success: true, message: 'Client services updated' });
  } catch (error: any) {
    console.error('Error upserting client services:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to update client services' });
  }
}

