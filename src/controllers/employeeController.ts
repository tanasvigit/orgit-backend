import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import { query } from '../config/database';
import bcrypt from 'bcryptjs';
import {
  getOrganizationStructureTree,
  resolveNodeReference,
  validateOrgFieldValuesForNode,
} from '../services/organizationStructureService';
import { userOrganizationsHasOrgFieldValues } from '../utils/orgFieldValuesColumn';
import {
  EMPLOYEE_ORG_NODE_BY_LEVEL_KEY,
  extractOrgNodeByLevel,
  resolvePrimaryFromOrgNodeByLevel,
  stripOrgNodeByLevel,
  validateOrgNodeByLevelChain,
} from '../utils/employeeOrgNodeLevels';
import {
  DEFAULT_EMPLOYEE_PERMISSIONS,
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeEmployeePermissions,
  normalizeNotificationSettings,
} from '../services/employeeMasterCatalog';
import { getEmployeeMasterColumnCaps } from '../utils/employeeMasterColumns';
import {
  applyMembershipProfileFields,
  applyUserProfileFields,
  employeeMasterMembershipSelectSql,
  employeeMasterUserSelectSql,
  mapEmployeeRow,
  parseEmployeeMasterPayload,
} from '../services/employeeMasterPersistence';

async function normalizeEmployeeOrgAssignment(
  organizationId: string,
  primaryOrgNodeIdInput: unknown,
  orgFieldValuesInput: unknown
): Promise<{ primaryOrgNodeId: string | null; orgFieldValues: Record<string, unknown> }> {
  const rawOrgFieldValues = parseOrgFieldValuesInput(orgFieldValuesInput) || {};
  const orgNodeByLevel = extractOrgNodeByLevel(rawOrgFieldValues);
  const schemaValues = stripOrgNodeByLevel(rawOrgFieldValues);

  let primaryOrgNodeId = normalizeNodeId(primaryOrgNodeIdInput);

  if (Object.keys(orgNodeByLevel).length > 0) {
    await validateOrgNodeByLevelChain(organizationId, orgNodeByLevel);
  }

  if (!primaryOrgNodeId && Object.keys(orgNodeByLevel).length > 0) {
    const tree = await getOrganizationStructureTree(organizationId, {
      includeArchived: false,
      includeInactive: false,
    });
    const levelsBelowGroup = tree.levels.filter((l) => l.levelNumber > 1 && l.isActive !== false);
    primaryOrgNodeId = resolvePrimaryFromOrgNodeByLevel(orgNodeByLevel, levelsBelowGroup, tree.nodes);
  }

  if (primaryOrgNodeId) {
    await resolveNodeReference(organizationId, primaryOrgNodeId, { activeOnly: false });
  }

  let normalizedSchema: Record<string, unknown> = {};
  if (primaryOrgNodeId && Object.keys(schemaValues).length > 0) {
    normalizedSchema = await validateOrgFieldValuesForNode(
      organizationId,
      primaryOrgNodeId,
      schemaValues
    );
  }

  const orgFieldValues =
    Object.keys(orgNodeByLevel).length > 0
      ? { ...normalizedSchema, [EMPLOYEE_ORG_NODE_BY_LEVEL_KEY]: orgNodeByLevel }
      : normalizedSchema;

  return { primaryOrgNodeId, orgFieldValues };
}

function parseOrgFieldValuesInput(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...(value as Record<string, unknown>) };
}

const normalizeNodeId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const normalizeNodeIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
    )
  );
};

/**
 * Add employee to organization by mobile number
 */
export const addEmployee = async (req: AuthRequest, res: Response) => {
  try {
    const organizationId = req.user?.organizationId;
    const {
      mobile,
      name,
      reportingTo,
      password,
      primaryOrgNodeId,
      secondaryOrgNodeIds,
      orgFieldValues,
      status: employeeStatus,
    } = req.body;
    const masterPayload = parseEmployeeMasterPayload(req.body);

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You are not associated with any organization',
      });
    }

    if (!mobile || !/^\+\d{6,20}$/.test(mobile)) {
      return res.status(400).json({
        success: false,
        error: 'Valid mobile number is required (international format: +911234567890)',
      });
    }

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Employee name is required',
      });
    }

    const orgAssignment = await normalizeEmployeeOrgAssignment(
      organizationId,
      primaryOrgNodeId,
      orgFieldValues
    );
    const normalizedPrimaryOrgNodeId = orgAssignment.primaryOrgNodeId;
    const normalizedOrgFieldValues = orgAssignment.orgFieldValues;
    const normalizedSecondaryOrgNodeIds = normalizeNodeIds(secondaryOrgNodeIds).filter(
      (nodeId) => nodeId !== normalizedPrimaryOrgNodeId
    );

    for (const nodeId of normalizedSecondaryOrgNodeIds) {
      await resolveNodeReference(organizationId, nodeId, { activeOnly: false });
    }

    // Check if user already exists
    const existingUser = await query(
      'SELECT id, role FROM users WHERE mobile = $1',
      [mobile]
    );

    let employeeUserId: string;

    if (existingUser.rows.length > 0) {
      // User exists, enforce single-organization membership.
      employeeUserId = existingUser.rows[0].id;

      const existingMemberships = await query(
        `SELECT organization_id
         FROM user_organizations
         WHERE user_id = $1`,
        [employeeUserId]
      );

      if (existingMemberships.rows.length > 0) {
        const alreadyInCurrentOrg = existingMemberships.rows.some(
          (row: any) => row.organization_id === organizationId
        );

        if (alreadyInCurrentOrg) {
          return res.status(400).json({
            success: false,
            error: 'User is already a member of this organization',
          });
        }

        return res.status(400).json({
          success: false,
          error: 'User is already a member of another organization',
        });
      }

      // Update user role to employee if needed
      const targetRole =
        masterPayload.userRole === 'admin' ? 'admin' : 'employee';
      if (existingUser.rows[0].role !== targetRole) {
        await query(
          'UPDATE users SET role = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [targetRole, employeeUserId]
        );
      }
    } else {
      // Create new user
    if (!password || password.trim().length < 4) {
      return res.status(400).json({
        success: false,
        error: 'Password is required (minimum 4 characters) for new users',
      });
    }

      const passwordHash = await bcrypt.hash(password, 10);
      
      const targetRole =
        masterPayload.userRole === 'admin' ? 'admin' : 'employee';
      const initialStatus =
        employeeStatus === 'inactive' ? 'inactive' : 'active';
      const newUserResult = await query(
        `INSERT INTO users (id, mobile, name, role, status, password_hash)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
         RETURNING id, mobile, name, role, status`,
        [mobile, name.trim(), targetRole, initialStatus, passwordHash]
      );

      employeeUserId = newUserResult.rows[0].id;

      // Create default profile
      await query(
        `INSERT INTO profiles (user_id, about, contact_number)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO NOTHING`,
        [employeeUserId, 'Hey there! I am using OrgIT.', mobile]
      );
    }

    const hasOrgFvColumn = await userOrganizationsHasOrgFieldValues();
    if (hasOrgFvColumn) {
      await query(
        `INSERT INTO user_organizations (
           id, user_id, organization_id, reporting_to, primary_org_node_id,
           secondary_org_node_ids, org_field_values, created_at, updated_at
         )
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::uuid[], $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, organization_id)
         DO UPDATE SET
           reporting_to = $3,
           primary_org_node_id = $4,
           secondary_org_node_ids = $5::uuid[],
           org_field_values = $6::jsonb,
           updated_at = CURRENT_TIMESTAMP`,
        [
          employeeUserId,
          organizationId,
          reportingTo || null,
          normalizedPrimaryOrgNodeId,
          normalizedSecondaryOrgNodeIds,
          JSON.stringify(normalizedOrgFieldValues),
        ]
      );
    } else {
      await query(
        `INSERT INTO user_organizations (
           id, user_id, organization_id, reporting_to, primary_org_node_id,
           secondary_org_node_ids, created_at, updated_at
         )
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::uuid[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, organization_id)
         DO UPDATE SET
           reporting_to = $3,
           primary_org_node_id = $4,
           secondary_org_node_ids = $5::uuid[],
           updated_at = CURRENT_TIMESTAMP`,
        [
          employeeUserId,
          organizationId,
          reportingTo || null,
          normalizedPrimaryOrgNodeId,
          normalizedSecondaryOrgNodeIds,
        ]
      );
    }

    const masterCaps = await getEmployeeMasterColumnCaps();
    if (masterCaps.membershipProfile) {
      const perms = normalizeEmployeePermissions(
        masterPayload.employeePermissions ?? DEFAULT_EMPLOYEE_PERMISSIONS
      );
      const notif = normalizeNotificationSettings(
        masterPayload.notificationSettings ?? DEFAULT_NOTIFICATION_SETTINGS
      );
      await query(
        `UPDATE user_organizations
         SET employee_permissions = $1::jsonb,
             notification_settings = $2::jsonb,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $3 AND organization_id = $4`,
        [JSON.stringify(perms), JSON.stringify(notif), employeeUserId, organizationId]
      );
    }
    await applyUserProfileFields(employeeUserId, masterPayload);
    await applyMembershipProfileFields(employeeUserId, organizationId, masterPayload);

    const caps = await getEmployeeMasterColumnCaps();
    const orgFvSelect = (await userOrganizationsHasOrgFieldValues())
      ? 'uo.org_field_values'
      : `'{}'::jsonb AS org_field_values`;
    const userResult = await query(
      `SELECT
         u.id, u.mobile, u.name, u.role, u.status, u.profile_photo_url, u.updated_at AS last_login_time,
         ${employeeMasterUserSelectSql(caps.userProfile)},
         uo.reporting_to, uo.primary_org_node_id, uo.secondary_org_node_ids,
         ${orgFvSelect},
         ${employeeMasterMembershipSelectSql(caps.membershipProfile)},
         reporter.name AS reporting_to_name, u.created_at
       FROM users u
       JOIN user_organizations uo ON u.id = uo.user_id
       LEFT JOIN users reporter ON uo.reporting_to = reporter.id
       WHERE u.id = $1 AND uo.organization_id = $2`,
      [employeeUserId, organizationId]
    );
    const orgTree = await getOrganizationStructureTree(organizationId, {
      includeArchived: true,
      includeInactive: true,
    });
    const nodeById = new Map(orgTree.nodes.map((n) => [n.id, n]));

    res.status(201).json({
      success: true,
      data: mapEmployeeRow(userResult.rows[0], nodeById),
      message: existingUser.rows.length > 0 
        ? 'Employee added to organization successfully' 
        : 'Employee created and added to organization successfully',
    });
  } catch (error: any) {
    console.error('Error adding employee:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to add employee',
    });
  }
};

/**
 * Get all employees in admin's organization
 */
export const getEmployees = async (req: AuthRequest, res: Response) => {
  try {
    const organizationId = req.user?.organizationId;

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You are not associated with any organization',
      });
    }

    const hasOrgFvColumn = await userOrganizationsHasOrgFieldValues();
    const orgFvSelect = hasOrgFvColumn
      ? 'uo.org_field_values'
      : `'{}'::jsonb AS org_field_values`;
    const caps = await getEmployeeMasterColumnCaps();

    const [result, orgTree] = await Promise.all([
      query(
      `SELECT 
        u.id,
        u.mobile,
        u.name,
        u.role,
        u.status,
        u.profile_photo_url,
        u.updated_at AS last_login_time,
        ${employeeMasterUserSelectSql(caps.userProfile)},
        uo.reporting_to,
        uo.primary_org_node_id,
        uo.secondary_org_node_ids,
        ${orgFvSelect},
        ${employeeMasterMembershipSelectSql(caps.membershipProfile)},
        reporter.name as reporting_to_name,
        u.created_at
       FROM users u
       JOIN user_organizations uo ON u.id = uo.user_id
       LEFT JOIN users reporter ON uo.reporting_to = reporter.id
       WHERE uo.organization_id = $1 AND u.role IN ('admin', 'employee')
       ORDER BY u.role DESC, u.name ASC`,
      [organizationId]
      ),
      getOrganizationStructureTree(organizationId, {
        includeArchived: true,
        includeInactive: true,
      }),
    ]);

    const nodeById = new Map(orgTree.nodes.map((node) => [node.id, node]));

    res.json({
      success: true,
      data: result.rows.map((row: any) => mapEmployeeRow(row, nodeById)),
    });
  } catch (error: any) {
    console.error('Error getting employees:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get employees',
    });
  }
};

/**
 * Update employee details
 */
export const updateEmployee = async (req: AuthRequest, res: Response) => {
  try {
    const organizationId = req.user?.organizationId;
    const { id } = req.params;
    const { name, reportingTo, status, primaryOrgNodeId, secondaryOrgNodeIds, orgFieldValues } = req.body;
    const masterPayload = parseEmployeeMasterPayload(req.body);

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You are not associated with any organization',
      });
    }

    // Check if employee belongs to admin's organization
    const employeeCheck = await query(
      'SELECT user_id FROM user_organizations WHERE user_id = $1 AND organization_id = $2',
      [id, organizationId]
    );

    if (employeeCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Employee not found in your organization',
      });
    }

    // Update user details
    if (name) {
      await query(
        'UPDATE users SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [name.trim(), id]
      );
    }

    if (status) {
      const normalizedStatus = status === 'inactive' ? 'inactive' : 'active';
      await query(
        'UPDATE users SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [normalizedStatus, id]
      );
    }

    if (masterPayload.userRole === 'admin' || masterPayload.userRole === 'employee') {
      await query(
        'UPDATE users SET role = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [masterPayload.userRole, id]
      );
    }

    await applyUserProfileFields(id, masterPayload);
    await applyMembershipProfileFields(id, organizationId, masterPayload);

    const primaryOrgNodeIdProvided = primaryOrgNodeId !== undefined || orgFieldValues !== undefined;
    const secondaryOrgNodeIdsProvided = secondaryOrgNodeIds !== undefined;
    const orgFieldValuesProvided = orgFieldValues !== undefined || primaryOrgNodeId !== undefined;

    let normalizedPrimaryOrgNodeId: string | null | undefined =
      primaryOrgNodeId !== undefined ? normalizeNodeId(primaryOrgNodeId) : undefined;
    let normalizedOrgFieldValuesJson: string | null = null;

    if (orgFieldValuesProvided) {
      const existingPrimary =
        normalizedPrimaryOrgNodeId === undefined
          ? (
              await query(
                'SELECT primary_org_node_id FROM user_organizations WHERE user_id = $1 AND organization_id = $2',
                [id, organizationId]
              )
            ).rows[0]?.primary_org_node_id || null
          : normalizedPrimaryOrgNodeId;

      const orgAssignment = await normalizeEmployeeOrgAssignment(
        organizationId,
        primaryOrgNodeId !== undefined ? primaryOrgNodeId : existingPrimary,
        orgFieldValues
      );
      normalizedPrimaryOrgNodeId = orgAssignment.primaryOrgNodeId;
      normalizedOrgFieldValuesJson = JSON.stringify(orgAssignment.orgFieldValues);
    }

    const normalizedSecondaryOrgNodeIds =
      secondaryOrgNodeIds !== undefined
        ? normalizeNodeIds(secondaryOrgNodeIds).filter((nodeId) => nodeId !== normalizedPrimaryOrgNodeId)
        : undefined;

    if (normalizedSecondaryOrgNodeIds) {
      for (const nodeId of normalizedSecondaryOrgNodeIds) {
        await resolveNodeReference(organizationId, nodeId, { activeOnly: false });
      }
    }

    const hasOrgFvColumn = await userOrganizationsHasOrgFieldValues();
    if (hasOrgFvColumn) {
      await query(
        `UPDATE user_organizations 
         SET reporting_to = $1,
             primary_org_node_id = CASE WHEN $2::boolean THEN $3::uuid ELSE primary_org_node_id END,
             secondary_org_node_ids = CASE
               WHEN $4::boolean THEN COALESCE($5::uuid[], ARRAY[]::uuid[])
               ELSE secondary_org_node_ids
             END,
             org_field_values = CASE
               WHEN $6::boolean THEN $7::jsonb
               ELSE org_field_values
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $8 AND organization_id = $9`,
        [
          reportingTo || null,
          primaryOrgNodeIdProvided,
          normalizedPrimaryOrgNodeId ?? null,
          secondaryOrgNodeIdsProvided,
          normalizedSecondaryOrgNodeIds ?? null,
          orgFieldValuesProvided,
          normalizedOrgFieldValuesJson,
          id,
          organizationId,
        ]
      );
    } else {
      await query(
        `UPDATE user_organizations 
         SET reporting_to = $1,
             primary_org_node_id = CASE WHEN $2::boolean THEN $3::uuid ELSE primary_org_node_id END,
             secondary_org_node_ids = CASE
               WHEN $4::boolean THEN COALESCE($5::uuid[], ARRAY[]::uuid[])
               ELSE secondary_org_node_ids
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $5 AND organization_id = $6`,
        [
          reportingTo || null,
          primaryOrgNodeIdProvided,
          normalizedPrimaryOrgNodeId ?? null,
          secondaryOrgNodeIdsProvided,
          normalizedSecondaryOrgNodeIds ?? null,
          id,
          organizationId,
        ]
      );
    }

    const caps = await getEmployeeMasterColumnCaps();
    const orgFvSelect = hasOrgFvColumn
      ? 'uo.org_field_values'
      : `'{}'::jsonb AS org_field_values`;

    const result = await query(
      `SELECT
         u.id, u.mobile, u.name, u.role, u.status, u.updated_at AS last_login_time,
         ${employeeMasterUserSelectSql(caps.userProfile)},
         uo.reporting_to, uo.primary_org_node_id, uo.secondary_org_node_ids,
         ${orgFvSelect},
         ${employeeMasterMembershipSelectSql(caps.membershipProfile)}
       FROM users u
       JOIN user_organizations uo ON u.id = uo.user_id
       WHERE u.id = $1 AND uo.organization_id = $2`,
      [id, organizationId]
    );
    const orgTree = await getOrganizationStructureTree(organizationId, {
      includeArchived: true,
      includeInactive: true,
    });
    const nodeById = new Map(orgTree.nodes.map((n) => [n.id, n]));

    res.json({
      success: true,
      data: mapEmployeeRow(result.rows[0], nodeById),
    });
  } catch (error: any) {
    console.error('Error updating employee:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update employee',
    });
  }
};

/**
 * Reset employee password (admin only)
 */
export const resetEmployeePassword = async (req: AuthRequest, res: Response) => {
  try {
    const organizationId = req.user?.organizationId;
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You are not associated with any organization',
      });
    }

    if (!newPassword || newPassword.trim().length < 4) {
      return res.status(400).json({
        success: false,
        error: 'New password is required and must be at least 4 characters',
      });
    }

    // Check if employee belongs to admin's organization
    const employeeCheck = await query(
      `SELECT u.id, u.name, u.mobile 
       FROM users u
       JOIN user_organizations uo ON u.id = uo.user_id
       WHERE u.id = $1 AND uo.organization_id = $2`,
      [id, organizationId]
    );

    if (employeeCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Employee not found in your organization',
      });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword.trim(), 10);

    // Update password
    await query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [passwordHash, id]
    );

    res.json({
      success: true,
      message: 'Password reset successfully',
    });
  } catch (error: any) {
    console.error('Error resetting employee password:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to reset password',
    });
  }
};

/**
 * Remove employee from organization (membership only)
 */
export const removeEmployee = async (req: AuthRequest, res: Response) => {
  try {
    const organizationId = req.user?.organizationId;
    const { id } = req.params;

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You are not associated with any organization',
      });
    }

    // Check if employee belongs to admin's organization
    const employeeCheck = await query(
      'SELECT user_id FROM user_organizations WHERE user_id = $1 AND organization_id = $2',
      [id, organizationId]
    );

    if (employeeCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Employee not found in your organization',
      });
    }

    // Remove dependent reporting links first inside this organization.
    await query(
      `UPDATE user_organizations
       SET reporting_to = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE organization_id = $1 AND reporting_to = $2`,
      [organizationId, id]
    );

    // Remove only organization membership (do not deactivate/delete user).
    await query(
      'DELETE FROM user_organizations WHERE user_id = $1 AND organization_id = $2',
      [id, organizationId]
    );

    res.json({
      success: true,
      message: 'Employee removed from organization successfully',
    });
  } catch (error: any) {
    console.error('Error removing employee:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to remove employee',
    });
  }
};

/**
 * Search users by mobile number for admin Add Employee form.
 * Looks up active users by matching the last digits of their mobile number,
 * without restricting to the admin's current organization.
 */
export const searchUsersByMobile = async (req: AuthRequest, res: Response) => {
  try {
    const search = (req.query.q as string) || '';
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;

    const trimmed = search.trim();
    if (!trimmed) {
      return res.json({
        success: true,
        data: [],
      });
    }

    // Work with digits only and match on the last 10 digits for robustness
    const digits = trimmed.replace(/\D/g, '');
    if (!digits) {
      return res.json({
        success: true,
        data: [],
      });
    }
    const last10 = digits.length >= 10 ? digits.slice(-10) : digits;

    const result = await query(
      `SELECT 
         id,
         mobile,
         name,
         role,
         status,
         profile_photo_url,
         bio
       FROM users
       WHERE status = 'active'
         AND REPLACE(REPLACE(mobile, ' ', ''), '+', '') LIKE '%' || $1 || '%'
       ORDER BY name ASC
       LIMIT $2`,
      [last10, limit]
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error: any) {
    console.error('Error searching users by mobile for admin:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to search users',
    });
  }
};


