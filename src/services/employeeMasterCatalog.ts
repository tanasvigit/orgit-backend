/** Employee master field catalog — aligned with org spreadsheet sections. */

export type EmployeeRights = {
  create: boolean;
  edit: boolean;
  delete: boolean;
  approve: boolean;
  view: boolean;
};

export type EmployeeTaskRights = {
  createTask: boolean;
  assignTask: boolean;
  reassignTask: boolean;
  closeTask: boolean;
  escalateTask: boolean;
  viewTeamTasks: boolean;
};

export type EmployeeWorkflowRoles = {
  preparedBy: boolean;
  reviewedBy: boolean;
  approvedBy: boolean;
  verifiedBy: boolean;
  escalation: boolean;
};

export type EmployeeDocumentRights = {
  upload: boolean;
  edit: boolean;
  approve: boolean;
  reject: boolean;
  download: boolean;
  view: boolean;
};

export type EmployeePermissions = {
  moduleAccess: string[];
  rights: EmployeeRights;
  taskRights: EmployeeTaskRights;
  workflowRoles: EmployeeWorkflowRoles;
  documentRights: EmployeeDocumentRights;
};

export type EmployeeNotificationSettings = {
  inApp: boolean;
  email: boolean;
  whatsapp: boolean;
  taskReminders: boolean;
  escalationAlerts: boolean;
};

export const EMPLOYMENT_TYPE_OPTIONS = ['Permanent', 'Contract'] as const;
export const EMPLOYEE_STATUS_OPTIONS = ['active', 'inactive'] as const;
export const GENDER_OPTIONS = ['Male', 'Female', 'Other', 'Prefer not to say'] as const;
export const USER_ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'employee', label: 'User' },
] as const;

export const MODULE_ACCESS_OPTIONS = [
  'All',
  'Messaging',
  'Dashboard',
  'Tasks',
  'Documents',
] as const;

export const DEFAULT_EMPLOYEE_PERMISSIONS: EmployeePermissions = {
  moduleAccess: ['Tasks', 'Messaging'],
  rights: { create: false, edit: true, delete: false, approve: false, view: true },
  taskRights: {
    createTask: false,
    assignTask: false,
    reassignTask: false,
    closeTask: true,
    escalateTask: false,
    viewTeamTasks: true,
  },
  workflowRoles: {
    preparedBy: true,
    reviewedBy: false,
    approvedBy: false,
    verifiedBy: false,
    escalation: false,
  },
  documentRights: {
    upload: false,
    edit: false,
    approve: false,
    reject: false,
    download: true,
    view: true,
  },
};

export const DEFAULT_NOTIFICATION_SETTINGS: EmployeeNotificationSettings = {
  inApp: true,
  email: true,
  whatsapp: false,
  taskReminders: true,
  escalationAlerts: true,
};

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'Y') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'N') return false;
  return fallback;
}

function pickRights(raw: Record<string, unknown> | undefined, defaults: EmployeeRights): EmployeeRights {
  return {
    create: asBool(raw?.create, defaults.create),
    edit: asBool(raw?.edit, defaults.edit),
    delete: asBool(raw?.delete, defaults.delete),
    approve: asBool(raw?.approve, defaults.approve),
    view: asBool(raw?.view, defaults.view),
  };
}

export function normalizeEmployeePermissions(input: unknown): EmployeePermissions {
  const base = DEFAULT_EMPLOYEE_PERMISSIONS;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return JSON.parse(JSON.stringify(base)) as EmployeePermissions;
  }
  const raw = input as Record<string, unknown>;
  const moduleAccess = Array.isArray(raw.moduleAccess)
    ? raw.moduleAccess.map((m) => String(m).trim()).filter(Boolean)
    : base.moduleAccess;
  const tr = (raw.taskRights && typeof raw.taskRights === 'object' ? raw.taskRights : {}) as Record<
    string,
    unknown
  >;
  const wr = (raw.workflowRoles && typeof raw.workflowRoles === 'object'
    ? raw.workflowRoles
    : {}) as Record<string, unknown>;
  const dr = (raw.documentRights && typeof raw.documentRights === 'object'
    ? raw.documentRights
    : {}) as Record<string, unknown>;

  return {
    moduleAccess: moduleAccess.length ? moduleAccess : [...base.moduleAccess],
    rights: pickRights(
      raw.rights as Record<string, unknown> | undefined,
      base.rights
    ),
    taskRights: {
      createTask: asBool(tr.createTask, base.taskRights.createTask),
      assignTask: asBool(tr.assignTask, base.taskRights.assignTask),
      reassignTask: asBool(tr.reassignTask, base.taskRights.reassignTask),
      closeTask: asBool(tr.closeTask, base.taskRights.closeTask),
      escalateTask: asBool(tr.escalateTask, base.taskRights.escalateTask),
      viewTeamTasks: asBool(tr.viewTeamTasks, base.taskRights.viewTeamTasks),
    },
    workflowRoles: {
      preparedBy: asBool(wr.preparedBy, base.workflowRoles.preparedBy),
      reviewedBy: asBool(wr.reviewedBy, base.workflowRoles.reviewedBy),
      approvedBy: asBool(wr.approvedBy, base.workflowRoles.approvedBy),
      verifiedBy: asBool(wr.verifiedBy, base.workflowRoles.verifiedBy),
      escalation: asBool(wr.escalation, base.workflowRoles.escalation),
    },
    documentRights: {
      upload: asBool(dr.upload, base.documentRights.upload),
      edit: asBool(dr.edit, base.documentRights.edit),
      approve: asBool(dr.approve, base.documentRights.approve),
      reject: asBool(dr.reject, base.documentRights.reject),
      download: asBool(dr.download, base.documentRights.download),
      view: asBool(dr.view, base.documentRights.view),
    },
  };
}

export function normalizeNotificationSettings(input: unknown): EmployeeNotificationSettings {
  const base = DEFAULT_NOTIFICATION_SETTINGS;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ...base };
  }
  const raw = input as Record<string, unknown>;
  return {
    inApp: asBool(raw.inApp, base.inApp),
    email: asBool(raw.email, base.email),
    whatsapp: asBool(raw.whatsapp, base.whatsapp),
    taskReminders: asBool(raw.taskReminders, base.taskReminders),
    escalationAlerts: asBool(raw.escalationAlerts, base.escalationAlerts),
  };
}

export function normalizeEmploymentType(raw: unknown): string | null {
  const v = String(raw || '').trim();
  if (!v) return null;
  const match = EMPLOYMENT_TYPE_OPTIONS.find((o) => o.toLowerCase() === v.toLowerCase());
  return match || v.slice(0, 20);
}
