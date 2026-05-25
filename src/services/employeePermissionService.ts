import { query } from '../config/database';
import {
  DEFAULT_EMPLOYEE_PERMISSIONS,
  DEFAULT_NOTIFICATION_SETTINGS,
  EmployeePermissions,
  EmployeeNotificationSettings,
  normalizeEmployeePermissions,
  normalizeNotificationSettings,
} from './employeeMasterCatalog';
import { getEmployeeMasterColumnCaps } from '../utils/employeeMasterColumns';

export type MembershipContext = {
  organizationId?: string;
  employeePermissions: EmployeePermissions;
  notificationSettings: EmployeeNotificationSettings;
};

export function bypassEmployeePermissions(role: string | undefined): boolean {
  return role === 'super_admin' || role === 'admin';
}

export function hasModuleAccess(
  permissions: EmployeePermissions,
  module: 'Messaging' | 'Dashboard' | 'Tasks' | 'Documents'
): boolean {
  const modules = permissions.moduleAccess || [];
  if (modules.some((m) => String(m).toLowerCase() === 'all')) return true;
  return modules.some((m) => String(m).toLowerCase() === module.toLowerCase());
}

export function hasTaskRight(
  permissions: EmployeePermissions,
  key: keyof EmployeePermissions['taskRights']
): boolean {
  return !!permissions.taskRights?.[key];
}

export function hasGeneralRight(
  permissions: EmployeePermissions,
  key: keyof EmployeePermissions['rights']
): boolean {
  return !!permissions.rights?.[key];
}

export function hasDocumentRight(
  permissions: EmployeePermissions,
  key: keyof EmployeePermissions['documentRights']
): boolean {
  return !!permissions.documentRights?.[key];
}

export async function loadMembershipContext(userId: string): Promise<MembershipContext> {
  const caps = await getEmployeeMasterColumnCaps();
  const permCols = caps.membershipProfile
    ? 'uo.employee_permissions, uo.notification_settings'
    : `'{}'::jsonb AS employee_permissions, '{}'::jsonb AS notification_settings`;

  const result = await query(
    `SELECT uo.organization_id, ${permCols}
     FROM user_organizations uo
     WHERE uo.user_id = $1
     LIMIT 1`,
    [userId]
  );

  if (result.rows.length === 0) {
    return {
      organizationId: undefined,
      employeePermissions: normalizeEmployeePermissions(DEFAULT_EMPLOYEE_PERMISSIONS),
      notificationSettings: normalizeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS),
    };
  }

  const row = result.rows[0];
  return {
    organizationId: row.organization_id,
    employeePermissions: normalizeEmployeePermissions(row.employee_permissions),
    notificationSettings: normalizeNotificationSettings(row.notification_settings),
  };
}

export function getEffectivePermissions(
  role: string | undefined,
  permissions: EmployeePermissions
): EmployeePermissions {
  if (bypassEmployeePermissions(role)) {
    return normalizeEmployeePermissions({
      moduleAccess: ['All'],
      rights: { create: true, edit: true, delete: true, approve: true, view: true },
      taskRights: {
        createTask: true,
        assignTask: true,
        reassignTask: true,
        closeTask: true,
        escalateTask: true,
        viewTeamTasks: true,
      },
      workflowRoles: {
        preparedBy: true,
        reviewedBy: true,
        approvedBy: true,
        verifiedBy: true,
        escalation: true,
      },
      documentRights: {
        upload: true,
        edit: true,
        approve: true,
        reject: true,
        download: true,
        view: true,
      },
    });
  }
  return permissions;
}

export function assertModuleAccess(
  role: string | undefined,
  permissions: EmployeePermissions,
  module: 'Messaging' | 'Dashboard' | 'Tasks' | 'Documents'
): void {
  const effective = getEffectivePermissions(role, permissions);
  if (!hasModuleAccess(effective, module)) {
    const err = new Error(`Forbidden: ${module} module not enabled for this user`);
    (err as any).statusCode = 403;
    throw err;
  }
}

export function assertTaskRight(
  role: string | undefined,
  permissions: EmployeePermissions,
  key: keyof EmployeePermissions['taskRights']
): void {
  const effective = getEffectivePermissions(role, permissions);
  if (!hasTaskRight(effective, key)) {
    const err = new Error(`Forbidden: missing task permission (${key})`);
    (err as any).statusCode = 403;
    throw err;
  }
}

export function assertGeneralRight(
  role: string | undefined,
  permissions: EmployeePermissions,
  key: keyof EmployeePermissions['rights']
): void {
  const effective = getEffectivePermissions(role, permissions);
  if (!hasGeneralRight(effective, key)) {
    const err = new Error(`Forbidden: missing permission (${key})`);
    (err as any).statusCode = 403;
    throw err;
  }
}

export function assertDocumentRight(
  role: string | undefined,
  permissions: EmployeePermissions,
  key: keyof EmployeePermissions['documentRights']
): void {
  const effective = getEffectivePermissions(role, permissions);
  if (!hasDocumentRight(effective, key)) {
    const err = new Error(`Forbidden: missing document permission (${key})`);
    (err as any).statusCode = 403;
    throw err;
  }
}
