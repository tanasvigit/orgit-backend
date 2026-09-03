import { query } from '../config/database';
import { resolveNodeReference } from './organizationStructureService';
import {
  normalizeEmployeePermissions,
  normalizeEmploymentType,
  normalizeNotificationSettings,
} from './employeeMasterCatalog';
import { getEmployeeMasterColumnCaps } from '../utils/employeeMasterColumns';

export type EmployeeMasterPayload = {
  employeeCode?: string | null;
  email?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  address?: string | null;
  panNumber?: string | null;
  dateOfJoining?: string | null;
  employmentType?: string | null;
  designation?: string | null;
  workLocationNodeId?: string | null;
  userRole?: string | null;
  employeePermissions?: unknown;
  notificationSettings?: unknown;
};

export function parseEmployeeMasterPayload(body: Record<string, unknown>): EmployeeMasterPayload {
  return {
    employeeCode: body.employeeCode != null ? String(body.employeeCode).trim() : body.employee_code != null ? String(body.employee_code).trim() : undefined,
    email: body.email != null ? String(body.email).trim() : undefined,
    dateOfBirth: body.dateOfBirth != null ? String(body.dateOfBirth) : body.date_of_birth != null ? String(body.date_of_birth) : undefined,
    gender: body.gender != null ? String(body.gender).trim() : undefined,
    address: body.address != null ? String(body.address).trim() : undefined,
    panNumber: body.panNumber != null ? String(body.panNumber).trim() : body.pan_number != null ? String(body.pan_number).trim() : undefined,
    dateOfJoining: body.dateOfJoining != null ? String(body.dateOfJoining) : body.date_of_joining != null ? String(body.date_of_joining) : undefined,
    employmentType: body.employmentType != null ? String(body.employmentType) : body.employment_type != null ? String(body.employment_type) : undefined,
    designation: body.designation != null ? String(body.designation).trim() : undefined,
    workLocationNodeId:
      body.workLocationNodeId != null
        ? String(body.workLocationNodeId)
        : body.work_location_node_id != null
          ? String(body.work_location_node_id)
          : undefined,
    userRole: body.userRole != null ? String(body.userRole) : body.user_role != null ? String(body.user_role) : undefined,
    employeePermissions: body.employeePermissions ?? body.employee_permissions,
    notificationSettings: body.notificationSettings ?? body.notification_settings,
  };
}

export function employeeMasterUserSelectSql(hasProfile: boolean): string {
  if (!hasProfile) {
    return `NULL::text AS employee_code, NULL::text AS email, NULL::date AS date_of_birth,
            NULL::text AS gender, NULL::text AS address, NULL::text AS pan_number`;
  }
  return `u.employee_code, u.email, u.date_of_birth, u.gender, u.address, u.pan_number`;
}

export function employeeMasterMembershipSelectSql(
  hasProfile: boolean,
  hasDesignation = true
): string {
  const designationExpr = hasDesignation ? 'uo.designation' : 'NULL::text AS designation';
  if (!hasProfile) {
    return `NULL::date AS date_of_joining, NULL::text AS employment_type,
            ${hasDesignation ? 'uo.designation' : 'NULL::text'} AS designation,
            NULL::uuid AS work_location_node_id,
            '{}'::jsonb AS employee_permissions,
            '{}'::jsonb AS notification_settings`;
  }
  if (hasDesignation) {
    return `uo.date_of_joining, uo.employment_type, uo.designation,
            uo.work_location_node_id, uo.employee_permissions, uo.notification_settings`;
  }
  return `uo.date_of_joining, uo.employment_type, ${designationExpr},
          uo.work_location_node_id, uo.employee_permissions, uo.notification_settings`;
}

export async function applyUserProfileFields(
  userId: string,
  payload: EmployeeMasterPayload
): Promise<void> {
  const caps = await getEmployeeMasterColumnCaps();
  if (!caps.userProfile) return;

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (payload.employeeCode !== undefined) {
    sets.push(`employee_code = NULLIF($${i++}, '')`);
    params.push(payload.employeeCode);
  }
  if (payload.email !== undefined) {
    sets.push(`email = NULLIF($${i++}, '')`);
    params.push(payload.email);
  }
  if (payload.dateOfBirth !== undefined) {
    sets.push(`date_of_birth = $${i++}::date`);
    params.push(payload.dateOfBirth || null);
  }
  if (payload.gender !== undefined) {
    sets.push(`gender = NULLIF($${i++}, '')`);
    params.push(payload.gender);
  }
  if (payload.address !== undefined) {
    sets.push(`address = NULLIF($${i++}, '')`);
    params.push(payload.address);
  }
  if (payload.panNumber !== undefined) {
    sets.push(`pan_number = NULLIF($${i++}, '')`);
    params.push(payload.panNumber);
  }

  if (sets.length === 0) return;
  params.push(userId);
  await query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${i}`,
    params
  );
}

export async function applyMembershipProfileFields(
  userId: string,
  organizationId: string,
  payload: EmployeeMasterPayload
): Promise<void> {
  const caps = await getEmployeeMasterColumnCaps();
  if (!caps.membershipProfile) return;

  if (payload.workLocationNodeId) {
    await resolveNodeReference(organizationId, payload.workLocationNodeId, { activeOnly: false });
  }

  const permissions =
    payload.employeePermissions !== undefined
      ? normalizeEmployeePermissions(payload.employeePermissions)
      : undefined;
  const notifications =
    payload.notificationSettings !== undefined
      ? normalizeNotificationSettings(payload.notificationSettings)
      : undefined;

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (payload.dateOfJoining !== undefined) {
    sets.push(`date_of_joining = $${i++}::date`);
    params.push(payload.dateOfJoining || null);
  }
  if (payload.employmentType !== undefined) {
    sets.push(`employment_type = $${i++}`);
    params.push(normalizeEmploymentType(payload.employmentType));
  }
  if (payload.designation !== undefined) {
    if (caps.hasDesignation) {
      sets.push(`designation = NULLIF($${i++}, '')`);
      params.push(payload.designation);
    }
  }
  if (payload.workLocationNodeId !== undefined) {
    sets.push(`work_location_node_id = $${i++}::uuid`);
    params.push(payload.workLocationNodeId || null);
  }
  if (permissions) {
    sets.push(`employee_permissions = $${i++}::jsonb`);
    params.push(JSON.stringify(permissions));
  }
  if (notifications) {
    sets.push(`notification_settings = $${i++}::jsonb`);
    params.push(JSON.stringify(notifications));
  }

  if (sets.length === 0) return;
  const userIdx = i;
  const orgIdx = i + 1;
  params.push(userId, organizationId);
  await query(
    `UPDATE user_organizations SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = $${userIdx} AND organization_id = $${orgIdx}`,
    params
  );
}

export function mapEmployeeRow(row: any, nodeById?: Map<string, { pathDisplay?: string; name?: string; levelLabel?: string }>) {
  const designation =
    row.designation || row.designation_legacy || null;
  const primaryNode = row.primary_org_node_id && nodeById ? nodeById.get(row.primary_org_node_id) : null;
  const workNode = row.work_location_node_id && nodeById ? nodeById.get(row.work_location_node_id) : null;
  const secondaryNodeIds = Array.isArray(row.secondary_org_node_ids) ? row.secondary_org_node_ids : [];

  return {
    ...row,
    designation,
    employee_code: row.employee_code ?? null,
    employeeCode: row.employee_code ?? null,
    email: row.email ?? null,
    date_of_birth: row.date_of_birth ?? null,
    dateOfBirth: row.date_of_birth ?? null,
    gender: row.gender ?? null,
    address: row.address ?? null,
    pan_number: row.pan_number ?? null,
    panNumber: row.pan_number ?? null,
    date_of_joining: row.date_of_joining ?? null,
    dateOfJoining: row.date_of_joining ?? null,
    employment_type: row.employment_type ?? null,
    employmentType: row.employment_type ?? null,
    work_location_node_id: row.work_location_node_id ?? null,
    workLocationNodeId: row.work_location_node_id ?? null,
    work_location_path: workNode?.pathDisplay ?? null,
    workLocationPath: workNode?.pathDisplay ?? null,
    employee_permissions: row.employee_permissions ?? {},
    employeePermissions: row.employee_permissions ?? {},
    notification_settings: row.notification_settings ?? {},
    notificationSettings: row.notification_settings ?? {},
    primary_org_path: primaryNode?.pathDisplay || null,
    primary_org_node_name: primaryNode?.name || null,
    primary_org_level_label: primaryNode?.levelLabel || null,
    secondary_org_paths: secondaryNodeIds
      .map((id: string) => nodeById?.get(id)?.pathDisplay)
      .filter(Boolean),
  };
}
