import ExcelJS from 'exceljs';
import { getClient } from '../config/database';
import { createHash } from 'crypto';
import { resolveInitialAssigneeStatus } from './userTaskLifecycle';
import {
  loadOrganizationAccountingYearStart,
  resolveBulkRecurrenceSchedule,
  setupRecurringTemplateForTask,
  formatBulkDateOnly,
  serializeBulkRecurrenceCursor,
  parseBulkDateOnlyToInstant,
  normalizeBulkNextRecurrenceForInsert,
} from './recurringTemplateSetup';
import { resolveNodeReference } from './organizationStructureService';

/** Bulk upload limits and safety */
const MAX_ROWS_PER_SHEET = 500;
const MAX_ERRORS_REPORTED = 100;
const TITLE_MAX = 500;
const STRING_MAX = 500;

export interface TaskBulkUploadResult {
  updated: { tasks: number };
  errors: Array<{ sheet?: string; row?: number; message: string }>;
}

/** Resolve user ID by mobile (same logic as entityMasterBulkService) */
async function resolveUserIdByMobile(client: any, mobile: string): Promise<string | null> {
  if (!mobile) return null;
  let normalized = (mobile || '').trim().replace(/\s/g, '');
  if (!normalized) return null;
  let digits = normalized.replace(/\D/g, '');
  if (digits.length > 12) {
    const first10 = digits.slice(0, 10);
    const last10 = digits.slice(-10);
    digits = first10;
    console.log('[TaskBulk] resolveUserIdByMobile: Excel number corruption (digits > 12), trying first 10', {
      original: normalized,
      digitsLength: digits.length,
      first10,
      last10,
    });
  }
  if (normalized.startsWith('+')) {
    if (digits.length >= 10) normalized = '+' + digits;
    else return null;
  } else {
    if (digits.length === 10) normalized = '+91' + digits;
    else if (digits.length === 12 && digits.startsWith('91')) normalized = '+' + digits;
    else if (digits.length >= 6 && digits.length <= 12) normalized = '+91' + digits.slice(-10);
    else return null;
  }
  const r = await client.query(
    "SELECT id FROM users WHERE REPLACE(mobile, ' ', '') = $1 OR mobile = $1 LIMIT 1",
    [normalized]
  );
  return r.rows.length > 0 ? r.rows[0].id : null;
}

/** Resolve user ID by email in organization */
async function resolveUserIdByEmail(
  client: any,
  organizationId: string,
  email: string
): Promise<string | null> {
  if (!email || !organizationId) return null;
  const trimmed = (email || '').trim().toLowerCase();
  if (!trimmed) return null;
  const r = await client.query(
    `SELECT uo.user_id FROM user_organizations uo
     JOIN users u ON u.id = uo.user_id
     WHERE uo.organization_id = $1 AND LOWER(TRIM(COALESCE(u.email, ''))) = $2
     LIMIT 1`,
    [organizationId, trimmed]
  );
  return r.rows.length > 0 ? r.rows[0].user_id : null;
}

/** Resolve user ID by mobile or name in organization */
async function resolveUserIdByMobileOrName(
  client: any,
  organizationId: string,
  value: string
): Promise<string | null> {
  if (!value || !organizationId) return null;
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  const looksLikeMobile = /^[\d\s+\-]+$/.test(trimmed.replace(/\s/g, ''));
  if (looksLikeMobile) {
    const userId = await resolveUserIdByMobile(client, trimmed);
    if (!userId) return null;
    const r = await client.query(
      'SELECT user_id FROM user_organizations WHERE user_id = $1 AND organization_id = $2 LIMIT 1',
      [userId, organizationId]
    );
    return r.rows.length > 0 ? userId : null;
  }
  const looksLikeEmail = trimmed.includes('@');
  if (looksLikeEmail) {
    return resolveUserIdByEmail(client, organizationId, trimmed);
  }
  // Normalize consecutive spaces so "Amit  Verma" and "Amit Verma" both match.
  const normalizedName = trimmed.replace(/\s+/g, ' ');
  const exactName = await client.query(
    `SELECT uo.user_id
     FROM user_organizations uo
     JOIN users u ON u.id = uo.user_id
     WHERE uo.organization_id = $1
       AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(u.name, '')), '[[:space:]]+', ' ', 'g')) = LOWER($2)
     LIMIT 1`,
    [organizationId, normalizedName]
  );
  if (exactName.rows.length > 0) return exactName.rows[0].user_id;

  // Fallback: allow prefix-style matches for common imports where surname/extra tokens differ.
  const prefixName = await client.query(
    `SELECT uo.user_id
     FROM user_organizations uo
     JOIN users u ON u.id = uo.user_id
     WHERE uo.organization_id = $1
       AND LOWER(REGEXP_REPLACE(TRIM(COALESCE(u.name, '')), '[[:space:]]+', ' ', 'g')) LIKE LOWER($2) || '%'
     ORDER BY LENGTH(COALESCE(u.name, '')) ASC
     LIMIT 1`,
    [organizationId, normalizedName]
  );
  return prefixName.rows.length > 0 ? prefixName.rows[0].user_id : null;
}

/** Split assignees string - handle comma, semicolon, and Excel corruption of "6300881211,8297700000" into one number */
function splitAssigneeParts(assigneesStr: string): string[] {
  if (!assigneesStr || !assigneesStr.trim()) return [];
  const s = assigneesStr.trim();
  const parts = s.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) return parts;
  if (parts.length === 1) {
    const digits = parts[0].replace(/\D/g, '');
    if (digits.length >= 18 && digits.length <= 22) {
      return [digits.slice(0, 10), digits.slice(10, 20)].filter((p) => p.length >= 10);
    }
    return parts;
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 18 && digits.length <= 22) {
    return [digits.slice(0, 10), digits.slice(10, 20)].filter((p) => p.length >= 10);
  }
  return s ? [s] : [];
}

/** Parse comma-separated assignees and resolve to user IDs in org */
async function resolveAssignees(
  client: any,
  organizationId: string,
  assigneesStr: string,
  cache: Map<string, string | null>
): Promise<{ userIds: string[]; errors: string[] }> {
  const userIds: string[] = [];
  const errors: string[] = [];
  const parts = splitAssigneeParts(assigneesStr);
  for (const part of parts) {
    const key = `${organizationId}|${part.toLowerCase()}`;
    let userId = cache.get(key);
    if (userId === undefined) {
      userId = await resolveUserIdByMobileOrName(client, organizationId, part);
      cache.set(key, userId);
    }
    if (userId) {
      if (!userIds.includes(userId)) userIds.push(userId);
    } else {
      console.log('[TaskBulk] assignee not found', { part, organizationId });
      errors.push(`Assignee not found: ${part}`);
    }
  }
  return { userIds, errors };
}

/** Parse date string - supports YYYY-MM-DD, DD/MM/YYYY, and Excel serial number */
function parseDate(val: any): Date | null {
  if (val == null || val === '') return null;
  if (typeof val === 'number') {
    const n = Math.floor(val);
    if (n >= 1 && n <= 2958465) {
      const utc = new Date((n - 25569) * 86400 * 1000);
      const d = new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }
  const s = String(val).trim();
  if (!s) return null;
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const d = new Date(parseInt(isoMatch[1], 10), parseInt(isoMatch[2], 10) - 1, parseInt(isoMatch[3], 10));
    return isNaN(d.getTime()) ? null : d;
  }
  const ddmmyyMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (ddmmyyMatch) {
    const d = new Date(
      parseInt(ddmmyyMatch[3], 10),
      parseInt(ddmmyyMatch[2], 10) - 1,
      parseInt(ddmmyyMatch[1], 10)
    );
    return isNaN(d.getTime()) ? null : d;
  }
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function toLocalDateOnlyString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getCellStr(row: ExcelJS.Row, colIdx: number): string {
  if (colIdx < 0) return '';
  const cell = row.getCell(colIdx);
  const val = cell?.value;
  if (val == null) return '';
  if (typeof val === 'number') {
    if (Number.isInteger(val)) {
      return String(val);
    }
    return val.toFixed(0);
  }
  if (val instanceof Date) {
    return toLocalDateOnlyString(val);
  }
  return String(val).trim();
}

function getCellStrMax(row: ExcelJS.Row, colIdx: number, maxLen: number): string {
  const s = getCellStr(row, colIdx);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function isRowEmpty(row: ExcelJS.Row, keyCols: number[]): boolean {
  for (const c of keyCols) {
    const v = row.getCell(c)?.value;
    if (v != null && String(v).trim() !== '') return false;
  }
  return true;
}

function colAny(headers: any[], ...keys: string[]): number {
  for (const k of keys) {
    const i = headers.findIndex((h: any) => String(h ?? '').trim().toLowerCase() === k.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

function getWorksheetByNames(workbook: ExcelJS.Workbook, names: string[]): ExcelJS.Worksheet | undefined {
  for (const n of names) {
    const w = workbook.getWorksheet(n);
    if (w) return w;
  }
  return undefined;
}

const TASK_BULK_VALIDATION_ROW_START = 2;
const TASK_BULK_VALIDATION_ROW_END = 1000;

function getTaskBulkSheetColumnRange(sheet: ExcelJS.Worksheet, columnKey: string): string {
  const letter = sheet.getColumn(columnKey).letter;
  if (!letter) {
    throw new Error(`Task bulk sheet missing column key: ${columnKey}`);
  }
  return `${letter}${TASK_BULK_VALIDATION_ROW_START}:${letter}${TASK_BULK_VALIDATION_ROW_END}`;
}

function addTaskBulkSheetListValidation(
  sheet: ExcelJS.Worksheet,
  columnKey: string,
  values: string[],
  errorMessage: string
): void {
  (sheet as any).dataValidations.add(getTaskBulkSheetColumnRange(sheet, columnKey), {
    type: 'list',
    allowBlank: true,
    formulae: [`"${values.join(',')}"`],
    showErrorMessage: true,
    errorTitle: 'Invalid value',
    error: errorMessage,
  });
}

/** Excel list dropdowns for Tasks bulk upload columns that map to enum fields. */
export function applyTaskBulkSheetValidations(sheet: ExcelJS.Worksheet): void {
  addTaskBulkSheetListValidation(
    sheet,
    'task_type',
    ['one_time', 'recurring'],
    'Select one_time or recurring.'
  );
  addTaskBulkSheetListValidation(
    sheet,
    'recurrence',
    ['Weekly', 'Monthly', 'Quarterly', 'Yearly', 'Daily'],
    'Select Daily, Weekly, Monthly, Quarterly, or Yearly.'
  );
  addTaskBulkSheetListValidation(sheet, 'auto_escalate', ['Yes', 'No'], 'Select Yes or No.');
  addTaskBulkSheetListValidation(
    sheet,
    'task_rollout_type',
    ['cycle_start'],
    'Recurring tasks use cycle_start.'
  );
  addTaskBulkSheetListValidation(
    sheet,
    'recurrence_end_type',
    ['never', 'specific_date', 'after_occurrences'],
    'Select never, specific_date, or after_occurrences.'
  );
  addTaskBulkSheetListValidation(
    sheet,
    'escalation_trigger',
    ['target_date', 'due_date'],
    'Select target_date or due_date.'
  );
}

/** Build Excel template for Tasks bulk upload */
export async function buildTaskTemplate(): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OrgIt Task Bulk Upload';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Tasks', {
    headerFooter: { firstHeader: 'OrgIt Tasks - Bulk Upload' },
  });

  sheet.columns = [
    { header: 'Task Title', key: 'title', width: 35 },
    // Added to align with web manual create-task modal fields (optional).
    { header: 'Client Name', key: 'client_name', width: 28 },
    { header: 'Assigned To', key: 'assigned_to', width: 35, numFmt: '@' },
    { header: 'Reporting Member', key: 'reporting_member', width: 22, numFmt: '@' },
    { header: 'Start Date', key: 'start_date', width: 14 },
    { header: 'Target Date', key: 'target_date', width: 14 },
    { header: 'Due Date', key: 'due_date', width: 14 },
    { header: 'Task Type', key: 'task_type', width: 14 },
    { header: 'Recurrence', key: 'recurrence', width: 18 },
    { header: 'Task Owner', key: 'task_owner', width: 18, numFmt: '@' },
    { header: 'Financial Value', key: 'financial_value', width: 16 },
    { header: 'Description', key: 'description', width: 40 },
    { header: 'Auto Escalate', key: 'auto_escalate', width: 14 },
    { header: 'Tags', key: 'tags', width: 24 },
    { header: 'Task Roll Out', key: 'task_rollout_type', width: 20 },
    { header: 'Recurrence End Type', key: 'recurrence_end_type', width: 22 },
    { header: 'Recurrence End Date', key: 'recurrence_end_date', width: 20 },
    { header: 'Recurrence After Occurrences', key: 'recurrence_after_occurrences', width: 28 },
    { header: 'Escalation Trigger', key: 'escalation_trigger', width: 20 },
    { header: 'Escalation Days Before', key: 'escalation_days_before', width: 22 },
    { header: 'Escalation Contacts', key: 'escalation_contact_ids', width: 26 },
    { header: 'Compliance ID', key: 'compliance_id', width: 22 },
    { header: 'Document Instance ID', key: 'document_instance_id', width: 24 },
  ];
  sheet.getRow(1).font = { bold: true };

  // Keep assignee / reporting / owner as text to avoid Excel number corruption.
  // Column indices are 1-based; note Client Name was inserted at column 2.
  sheet.getColumn(3).numFmt = '@'; // Assigned To
  sheet.getColumn(4).numFmt = '@'; // Reporting Member
  sheet.getColumn(10).numFmt = '@'; // Task Owner

  applyTaskBulkSheetValidations(sheet);

  return (await workbook.xlsx.writeBuffer()) as ExcelJS.Buffer;
}

/** Payload shape for creating one task (used by queue worker and optionally by parseAndApply). */
export interface TaskBulkJobPayload {
  title: string;
  /** Optional client name text from upload sheet. */
  clientName: string | null;
  /** Optional client/entity link (resolved from "Client Name" column). */
  clientEntityId: string | null;
  description: string | null;
  taskType: string;
  startDate: string | null;
  targetDate: string | null;
  dueDate: string;
  frequency: string | null;
  recurrenceType: string | null;
  recurrenceInterval: number;
  specificWeekday: number | null;
  nextRecurrenceDate: string | null;
  taskRolloutType: string | null;
  recurrenceEndType: string | null;
  recurrenceEndDate: string | null;
  recurrenceAfterOccurrences: number | null;
  assigneeIds: string[];
  taskCreatorId: string;
  reportingMemberId: string | null;
  parsedFinancialValue: number | null;
  autoEscalate: boolean;
  escalationTrigger: string | null;
  escalationDaysBefore: number | null;
  escalationContactIds: string[];
  escalationRules: object | null;
  complianceId: string | null;
  documentInstanceId: string | null;
  allAssigneeIds: string[];
  isDifferentOwner: boolean;
  idempotencyKey?: string;
  /** 1-based Excel row index; uniqueness guard when many rows share identical task fields */
  sourceRowIndex: number;
}

/**
 * Create one task from a pre-resolved payload. Used by the bulk queue worker.
 * userId = uploader (for activity audit).
 * Returns task id and whether a new row was inserted (false when idempotency short-circuits).
 */
export async function createTaskFromPayload(
  client: any,
  payload: TaskBulkJobPayload,
  organizationId: string,
  userId: string
): Promise<{ taskId: string; inserted: boolean }> {
  const {
    title,
    clientName,
    clientEntityId,
    description,
    taskType,
    startDate,
    targetDate,
    dueDate,
    frequency,
    recurrenceType,
    recurrenceInterval,
    specificWeekday,
    nextRecurrenceDate,
    taskRolloutType,
    recurrenceEndType,
    recurrenceEndDate,
    recurrenceAfterOccurrences,
    taskCreatorId,
    reportingMemberId,
    parsedFinancialValue,
    autoEscalate,
    escalationTrigger,
    escalationDaysBefore,
    escalationContactIds,
    escalationRules,
    complianceId,
    documentInstanceId,
    allAssigneeIds,
    isDifferentOwner,
    idempotencyKey,
  } = payload;

  let orgStructureNodeId: string | null = null;
  let orgStructurePath: unknown = null;
  let orgStructureLevelKey: string | null = null;
  if (clientEntityId) {
    const ceRes = await client.query(
      `SELECT ce.org_structure_node_id, ce.org_structure_path, n.level_key AS node_level_key
       FROM client_entities ce
       LEFT JOIN organization_structure_nodes n ON n.id = ce.org_structure_node_id
       WHERE ce.id = $1
       LIMIT 1`,
      [clientEntityId]
    );
    if (ceRes.rows.length > 0) {
      const row = ceRes.rows[0];
      orgStructureNodeId = row.org_structure_node_id ?? null;
      orgStructurePath = row.org_structure_path ?? null;
      orgStructureLevelKey = row.node_level_key ?? null;
      if (orgStructureNodeId && orgStructurePath == null) {
        try {
          const ref = await resolveNodeReference(organizationId, orgStructureNodeId, { activeOnly: false });
          orgStructurePath = ref.path;
          orgStructureLevelKey = ref.levelKey;
        } catch {
          orgStructurePath = null;
        }
      }
    }
  }

  // Guard against accidental duplicate processing of the same bulk row (same file + sheet row).
  // We persist the key in task_activities message and short-circuit if it exists.
  if (idempotencyKey) {
    const existingTask = await client.query(
      `SELECT ta.task_id
       FROM task_activities ta
       JOIN tasks t ON t.id = ta.task_id
       WHERE ta.activity_type = 'created'
         AND ta.message LIKE $1
         AND t.organization_id = $2
       ORDER BY ta.created_at DESC
       LIMIT 1`,
      [`%bulk_key:${idempotencyKey}%`, organizationId]
    );
    if (existingTask.rows.length > 0) {
      return { taskId: existingTask.rows[0].task_id, inserted: false };
    }
  }

  const isRecurring = taskType === 'recurring';
  const taskTypeForInsert = isRecurring ? 'recurring_instance' : taskType;
  const startDateForInsert =
    isRecurring && recurrenceType === 'daily' && startDate
      ? parseBulkDateOnlyToInstant(startDate)?.toISOString() ?? startDate
      : startDate;
  const nextRecurrenceForInsert = normalizeBulkNextRecurrenceForInsert(
    nextRecurrenceDate,
    recurrenceType
  );

  const columnCheck = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'tasks'
     AND column_name IN (
       'created_by',
       'creator_id',
       'reporting_member_id',
       'financial_value',
       'finance_type',
       'auto_escalate',
       'escalation_rules',
       'client_entity_id',
       'client_name',
       'org_structure_node_id',
       'org_structure_path',
       'org_structure_level_key',
       'compliance_id',
       'document_instance_id',
       'task_rollout_type',
       'recurrence_end_type',
       'recurrence_end_date',
       'recurrence_after_occurrences',
       'escalation_trigger',
       'escalation_days_before',
       'recurrence_type',
       'recurrence_interval',
       'recurrence_template_id',
       'parent_task_id',
       'recurrence_instance_no',
       'category'
     )`
  );
  const hasCreatedBy = columnCheck.rows.some((c: any) => c.column_name === 'created_by');
  const hasCreatorId = columnCheck.rows.some((c: any) => c.column_name === 'creator_id');
  const hasReportingMemberId = columnCheck.rows.some((c: any) => c.column_name === 'reporting_member_id');
  const hasFinancialValue = columnCheck.rows.some((c: any) => c.column_name === 'financial_value');
  const hasFinanceType = columnCheck.rows.some((c: any) => c.column_name === 'finance_type');
  const hasAutoEscalate = columnCheck.rows.some((c: any) => c.column_name === 'auto_escalate');
  const hasEscalationRules = columnCheck.rows.some((c: any) => c.column_name === 'escalation_rules');
  const hasClientEntityId = columnCheck.rows.some((c: any) => c.column_name === 'client_entity_id');
  const hasClientName = columnCheck.rows.some((c: any) => c.column_name === 'client_name');
  const hasOrgStructureNodeId = columnCheck.rows.some((c: any) => c.column_name === 'org_structure_node_id');
  const hasOrgStructurePath = columnCheck.rows.some((c: any) => c.column_name === 'org_structure_path');
  const hasOrgStructureLevelKey = columnCheck.rows.some((c: any) => c.column_name === 'org_structure_level_key');
  const hasComplianceId = columnCheck.rows.some((c: any) => c.column_name === 'compliance_id');
  const hasDocumentInstanceId = columnCheck.rows.some((c: any) => c.column_name === 'document_instance_id');
  const hasTaskRolloutType = columnCheck.rows.some((c: any) => c.column_name === 'task_rollout_type');
  const hasRecurrenceEndType = columnCheck.rows.some((c: any) => c.column_name === 'recurrence_end_type');
  const hasRecurrenceEndDate = columnCheck.rows.some((c: any) => c.column_name === 'recurrence_end_date');
  const hasRecurrenceAfterOccurrences = columnCheck.rows.some((c: any) => c.column_name === 'recurrence_after_occurrences');
  const hasEscalationTrigger = columnCheck.rows.some((c: any) => c.column_name === 'escalation_trigger');
  const hasEscalationDaysBefore = columnCheck.rows.some((c: any) => c.column_name === 'escalation_days_before');
  const hasRecurrenceType = columnCheck.rows.some((c: any) => c.column_name === 'recurrence_type');
  const hasRecurrenceInterval = columnCheck.rows.some((c: any) => c.column_name === 'recurrence_interval');
  const hasRecurrenceTemplateId = columnCheck.rows.some((c: any) => c.column_name === 'recurrence_template_id');
  const hasParentTaskId = columnCheck.rows.some((c: any) => c.column_name === 'parent_task_id');
  const hasRecurrenceInstanceNo = columnCheck.rows.some((c: any) => c.column_name === 'recurrence_instance_no');
  const hasCategory = columnCheck.rows.some((c: any) => c.column_name === 'category');

  let insertCols = [
    'title',
    'description',
    'task_type',
    'organization_id',
    'start_date',
    'target_date',
    'due_date',
    'frequency',
    'specific_weekday',
    'next_recurrence_date',
    'status',
  ];
  let insertVals: any[] = [
    title,
    description,
    taskTypeForInsert,
    organizationId,
    startDateForInsert || null,
    targetDate || null,
    dueDate,
    frequency,
    specificWeekday,
    nextRecurrenceForInsert || null,
    'pending',
  ];

  if (hasCreatedBy) {
    insertCols.push('created_by');
    insertVals.push(taskCreatorId);
  }
  if (hasCreatorId) {
    insertCols.push('creator_id');
    insertVals.push(taskCreatorId);
  }
  if (hasFinancialValue && parsedFinancialValue != null && Number.isFinite(parsedFinancialValue)) {
    insertCols.push('financial_value');
    insertVals.push(parsedFinancialValue);
  }
  if (hasFinanceType && parsedFinancialValue != null && Number.isFinite(parsedFinancialValue)) {
    insertCols.push('finance_type');
    insertVals.push('income');
  }
  if (hasAutoEscalate) {
    insertCols.push('auto_escalate');
    insertVals.push(autoEscalate);
  }
  if (hasEscalationRules && escalationRules) {
    insertCols.push('escalation_rules');
    insertVals.push(JSON.stringify(escalationRules));
  }
  if (hasReportingMemberId && reportingMemberId) {
    insertCols.push('reporting_member_id');
    insertVals.push(reportingMemberId);
  }
  if (hasClientEntityId && clientEntityId) {
    insertCols.push('client_entity_id');
    insertVals.push(clientEntityId);
  }
  if (hasClientName && clientName) {
    insertCols.push('client_name');
    insertVals.push(clientName);
  }
  if (hasOrgStructureNodeId && orgStructureNodeId) {
    insertCols.push('org_structure_node_id');
    insertVals.push(orgStructureNodeId);
  }
  if (hasOrgStructurePath && orgStructurePath != null) {
    insertCols.push('org_structure_path');
    insertVals.push(
      typeof orgStructurePath === 'string' ? orgStructurePath : JSON.stringify(orgStructurePath)
    );
  }
  if (hasOrgStructureLevelKey && orgStructureLevelKey) {
    insertCols.push('org_structure_level_key');
    insertVals.push(orgStructureLevelKey);
  }
  if (hasComplianceId && complianceId) {
    insertCols.push('compliance_id');
    insertVals.push(complianceId);
  }
  if (hasDocumentInstanceId && documentInstanceId) {
    insertCols.push('document_instance_id');
    insertVals.push(documentInstanceId);
  }
  if (hasTaskRolloutType && taskRolloutType) {
    insertCols.push('task_rollout_type');
    insertVals.push(taskRolloutType);
  }
  if (hasRecurrenceEndType && recurrenceEndType) {
    insertCols.push('recurrence_end_type');
    insertVals.push(recurrenceEndType);
  }
  if (hasRecurrenceEndDate && recurrenceEndDate) {
    insertCols.push('recurrence_end_date');
    insertVals.push(recurrenceEndDate);
  }
  if (hasRecurrenceAfterOccurrences && recurrenceAfterOccurrences != null) {
    insertCols.push('recurrence_after_occurrences');
    insertVals.push(recurrenceAfterOccurrences);
  }
  if (hasEscalationTrigger && escalationTrigger) {
    insertCols.push('escalation_trigger');
    insertVals.push(escalationTrigger);
  }
  if (hasEscalationDaysBefore && escalationDaysBefore != null) {
    insertCols.push('escalation_days_before');
    insertVals.push(escalationDaysBefore);
  }
  if (isRecurring && hasRecurrenceType && recurrenceType) {
    insertCols.push('recurrence_type');
    insertVals.push(recurrenceType);
  }
  if (isRecurring && hasRecurrenceInterval) {
    insertCols.push('recurrence_interval');
    insertVals.push(recurrenceInterval || 1);
  }
  if (isRecurring && hasCategory) {
    insertCols.push('category');
    insertVals.push('general');
  }
  if (isRecurring && hasParentTaskId) {
    insertCols.push('parent_task_id');
    insertVals.push(null);
  }
  if (isRecurring && hasRecurrenceTemplateId) {
    insertCols.push('recurrence_template_id');
    insertVals.push(null);
  }
  if (isRecurring && hasRecurrenceInstanceNo) {
    insertCols.push('recurrence_instance_no');
    insertVals.push(1);
  }

  const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(', ');
  const taskResult = await client.query(
    `INSERT INTO tasks (${insertCols.join(', ')})
     VALUES (${placeholders})
     RETURNING *`,
    insertVals
  );
  const task = taskResult.rows[0];

  const initialAssigneeStatus = resolveInitialAssigneeStatus({ startDate });

  // Ensure reporting member can see task + verify others.
  // Some legacy templates/users may provide reporting_member_id but omit them from assigneeIds.
  const effectiveAssigneeIds = new Set<string>((allAssigneeIds || []).filter(Boolean));
  if (taskCreatorId) effectiveAssigneeIds.add(taskCreatorId);
  if (reportingMemberId) effectiveAssigneeIds.add(reportingMemberId);

  for (const assigneeId of Array.from(effectiveAssigneeIds)) {
    const role =
      assigneeId === taskCreatorId
        ? 'creator'
        : reportingMemberId && assigneeId === reportingMemberId
        ? 'reporting_member'
        : 'member';

    await client.query(
      `INSERT INTO task_assignees (task_id, user_id, status, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (task_id, user_id) DO UPDATE
       SET status = EXCLUDED.status`,
      [task.id, assigneeId, initialAssigneeStatus, role]
    );
  }

  const createdSuffix = ` with assignees${idempotencyKey ? ` [bulk_key:${idempotencyKey}]` : ''}`;
  await client.query(
    `INSERT INTO task_activities (task_id, user_id, activity_type, new_value, message)
     VALUES ($1, $2, 'created', 'pending', $3)`,
    [task.id, userId, `Task "${title}" created${createdSuffix}`]
  );

  const convCheck = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'conversations' AND column_name = 'type'`
  );
  const hasType = convCheck.rows.length > 0;

  let convResult: any;
  if (hasType) {
    convResult = await client.query(
      `INSERT INTO conversations (id, type, name, is_group, is_task_group, task_id, created_by)
       VALUES (gen_random_uuid(), 'group', $1, TRUE, TRUE, $2, $3)
       RETURNING id`,
      [`Task: ${title}`, task.id, taskCreatorId]
    );
  } else {
    convResult = await client.query(
      `INSERT INTO conversations (name, is_group, is_task_group, task_id, created_by)
       VALUES ($1, TRUE, TRUE, $2, $3)
       RETURNING id`,
      [`Task: ${title}`, task.id, taskCreatorId]
    );
  }
  const conversationId = convResult?.rows?.[0]?.id;
  if (conversationId) {
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       VALUES ($1, $2, 'admin')
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversationId, taskCreatorId]
    );
    for (const assigneeId of Array.from(effectiveAssigneeIds)) {
      if (String(assigneeId) === String(taskCreatorId)) continue;
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [conversationId, assigneeId]
      );
    }
    if (isDifferentOwner) {
      await client.query(
        `DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, userId]
      );
    }

    const creatorRow = await client.query('SELECT name FROM users WHERE id = $1', [taskCreatorId]);
    const creatorName = creatorRow.rows[0]?.name || 'Admin';
    const msgColCheck = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'messages' AND column_name = 'sender_organization_id'`
    );
    const hasSenderOrgId = msgColCheck.rows.some((c: any) => c.column_name === 'sender_organization_id');
    let msgCols = ['conversation_id', 'sender_id', 'content', 'message_type'];
    let msgVals: any[] = [
      conversationId,
      taskCreatorId,
      `Task created by ${creatorName}`,
      'text',
    ];
    if (hasSenderOrgId && organizationId) {
      msgCols.push('sender_organization_id');
      msgVals.push(organizationId);
    }
    const msgPh = msgVals.map((_, i) => `$${i + 1}`).join(', ');
    const msgResult = await client.query(
      `INSERT INTO messages (${msgCols.join(', ')})
       VALUES (${msgPh})
       RETURNING id`,
      msgVals
    );
    const messageId = msgResult.rows[0]?.id;
    if (messageId) {
      try {
        await client.query(
          `INSERT INTO message_status (message_id, user_id, status, status_at)
           VALUES ($1, $2, 'sent', NOW())`,
          [messageId, taskCreatorId]
        );
      } catch (msgErr: any) {
        if (msgErr?.message?.includes('created_at')) {
          await client.query(
            `INSERT INTO message_status (message_id, user_id, status, created_at)
             VALUES ($1, $2, 'sent', NOW())`,
            [messageId, taskCreatorId]
          );
        }
      }
    }
  }

  if (autoEscalate && escalationContactIds.length > 0) {
    const uniqueEscalationContacts = Array.from(new Set(escalationContactIds.filter(Boolean)));
    for (const escalationUserId of uniqueEscalationContacts) {
      await client.query(
        `INSERT INTO task_assignees (task_id, user_id, status, role)
         VALUES ($1, $2, $3, 'escalation_contact')
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [task.id, escalationUserId, initialAssigneeStatus]
      );
      if (conversationId) {
        await client.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT (conversation_id, user_id) DO NOTHING`,
          [conversationId, escalationUserId]
        );
      }
    }
  }

  if (isRecurring && recurrenceType && nextRecurrenceForInsert) {
    await setupRecurringTemplateForTask(client, {
      task,
      organizationId,
      title,
      description,
      category: 'general',
      creatorId: taskCreatorId,
      reportingMemberId: reportingMemberId || null,
      recurrenceType,
      recurrenceInterval: recurrenceInterval || 1,
      specificWeekday,
      nextRecurrenceDate: nextRecurrenceForInsert,
      recurrenceEndType,
      recurrenceEndDate,
      recurrenceAfterOccurrences,
      assigneeIds: effectiveAssigneeIds,
      escalationContactIds,
    });
  }

  return { taskId: task.id, inserted: true };
}

/**
 * Parse uploaded workbook and create tasks.
 * Admin: restricted to req.user.organizationId.
 */
export async function parseAndApply(
  fileBuffer: Buffer,
  userId: string,
  organizationId: string | null
): Promise<TaskBulkUploadResult> {
  const result: TaskBulkUploadResult = {
    updated: { tasks: 0 },
    errors: [],
  };

  if (!organizationId) {
    result.errors.push({ message: 'Organization ID is required. User must be associated with an organization.' });
    return result;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as any);

  // New: process optional master sheets first (if present). This is best-effort and does not block task creation.
  // Backward compatible: old Excel files won't have these sheets and will skip quietly.
  const pushError = (err: { sheet?: string; row?: number; message: string }) => {
    if (result.errors.length >= MAX_ERRORS_REPORTED) return;
    result.errors.push(err);
    if (result.errors.length === MAX_ERRORS_REPORTED) {
      result.errors.push({
        message: `Too many errors; only first ${MAX_ERRORS_REPORTED} reported. Fix reported rows and re-upload.`,
      });
    }
  };
  const tasksSheet = workbook.getWorksheet('Tasks') || workbook.worksheets[0];
  console.log('[TaskBulk] parseAndApply start', {
    userId,
    organizationId,
    sheetName: tasksSheet?.name,
    rowCount: tasksSheet?.rowCount,
  });
  if (!tasksSheet || (tasksSheet.rowCount ?? 0) < 2) {
    result.errors.push({ message: 'No "Tasks" sheet found or sheet has no data rows.' });
    return result;
  }

  const client = await getClient();
  const assigneeCache = new Map<string, string | null>();
  try {
    const headers = tasksSheet.getRow(1).values as any[];
    const col = (key: string): number => {
      const keys = key.toLowerCase().split('|');
      for (const k of keys) {
        const i = headers.findIndex((h: any) => String(h || '').trim().toLowerCase() === k);
        if (i >= 0) return i;
      }
      return -1;
    };

    const titleCol = col('task title|title');
    const clientNameCol = col('client name|client_name|client');
    const assignedToCol = col('assigned to|assignees|assigned_to');
    const reportingMemberCol = col('reporting member|reporting_member');
    const startDateCol = col('start date|start_date');
    const targetDateCol = col('target date|target_date');
    const dueDateCol = col('due date|due_date');
    const taskTypeCol = col('task type|task_type');
    const recurrenceCol = col('recurrence|recurrence type|recurrence_type');
    const taskOwnerCol = col('task owner|task_owner');
    const financialValueCol = col('financial value|financial_value');
    const descCol = col('description');
    const autoEscalateCol = col('auto escalate|auto_escalate');
    const tagsCol = col('tags');
    const taskRolloutTypeCol = col('task roll out|task rollout|task_rollout_type');
    const recurrenceEndTypeCol = col('recurrence end type|recurrence_end_type');
    const recurrenceEndDateCol = col('recurrence end date|recurrence_end_date');
    const recurrenceAfterOccurrencesCol = col('recurrence after occurrences|recurrence_after_occurrences');
    const escalationTriggerCol = col('escalation trigger|escalation_trigger');
    const escalationDaysBeforeCol = col('escalation days before|escalation_days_before');
    const escalationContactsCol = col('escalation contacts|escalation_contact_ids|escalation contacts ids');
    const complianceIdCol = col('compliance id|compliance_id');
    const documentInstanceIdCol = col('document instance id|document_instance_id');

    console.log('[TaskBulk] column indices', {
      headers: (headers as any[]).filter(Boolean).map((h: any, i: number) => ({ i, h: String(h || '').trim() })),
      titleCol,
      assignedToCol,
      dueDateCol,
      taskTypeCol,
    });

    if (titleCol < 0 || dueDateCol < 0) {
      pushError({ sheet: tasksSheet.name, message: 'Missing required columns: Title and Due Date' });
      return result;
    }

    const maxRow = Math.min(tasksSheet.rowCount ?? 0, MAX_ROWS_PER_SHEET + 1);
    if ((tasksSheet.rowCount ?? 0) > MAX_ROWS_PER_SHEET + 1) {
      pushError({
        sheet: tasksSheet.name,
        message: `Sheet has more than ${MAX_ROWS_PER_SHEET} rows; only first ${MAX_ROWS_PER_SHEET} processed.`,
      });
    }

    let accountingYearStartForOrg: string | null | undefined = undefined;

    for (let r = 2; r <= maxRow; r++) {
    try {
      const row = tasksSheet.getRow(r);
      if (isRowEmpty(row, [titleCol, dueDateCol])) continue;

      const title = getCellStrMax(row, titleCol, TITLE_MAX);
      if (!title) {
        pushError({ sheet: tasksSheet.name, row: r, message: 'Title is required' });
        continue;
      }

      const dueDateVal = getCellStr(row, dueDateCol);
      const assignedToVal = getCellStr(row, assignedToCol);
      if (r <= 4) {
        console.log('[TaskBulk] row', r, {
          title,
          dueDateVal,
          dueDateValType: typeof tasksSheet.getRow(r).getCell(dueDateCol)?.value,
          assignedToVal,
          assignedToValType: typeof tasksSheet.getRow(r).getCell(assignedToCol)?.value,
        });
      }
      const dueDate = parseDate(dueDateVal);
      if (!dueDate) {
        const msg = !dueDateVal || !dueDateVal.trim()
          ? 'Due date is required'
          : `Invalid due date: ${dueDateVal} (use YYYY-MM-DD or DD/MM/YYYY)`;
        pushError({ sheet: tasksSheet.name, row: r, message: msg });
        continue;
      }

      const taskTypeRaw = getCellStr(row, taskTypeCol).toLowerCase() || 'one_time';
      const taskType = taskTypeRaw === 'recurring' ? 'recurring' : 'one_time';

      const description = getCellStrMax(row, descCol, STRING_MAX) || null;
      const startDate = parseDate(getCellStr(row, startDateCol));
      const targetDate = parseDate(getCellStr(row, targetDateCol));

      const financialValueStr = getCellStr(row, financialValueCol);
      const parsedFinancialValue = financialValueStr
        ? (parseFloat(financialValueStr) || null)
        : null;
      const tagsText = getCellStrMax(row, tagsCol, STRING_MAX) || null;

      const autoEscalateStr = getCellStr(row, autoEscalateCol).toLowerCase();
      const autoEscalate = autoEscalateStr === 'yes' || autoEscalateStr === 'true' || autoEscalateStr === '1';
      const taskRolloutTypeRaw = getCellStr(row, taskRolloutTypeCol).toLowerCase();
      const taskRolloutType = taskRolloutTypeRaw || (taskType === 'recurring' ? 'cycle_start' : null);
      const recurrenceEndTypeRaw = getCellStr(row, recurrenceEndTypeCol).toLowerCase();
      const recurrenceEndType = recurrenceEndTypeRaw || null;
      const recurrenceEndDateParsed = parseDate(getCellStr(row, recurrenceEndDateCol));
      const recurrenceEndDate = recurrenceEndDateParsed ? formatBulkDateOnly(recurrenceEndDateParsed) : null;
      const recurrenceAfterOccurrencesRaw = getCellStr(row, recurrenceAfterOccurrencesCol);
      const recurrenceAfterOccurrences = recurrenceAfterOccurrencesRaw
        ? Number.parseInt(recurrenceAfterOccurrencesRaw, 10) || null
        : null;
      const escalationTriggerRaw = getCellStr(row, escalationTriggerCol).toLowerCase();
      const escalationTrigger = escalationTriggerRaw || null;
      const escalationDaysBeforeRaw = getCellStr(row, escalationDaysBeforeCol);
      const escalationDaysBefore = escalationDaysBeforeRaw
        ? Number.parseInt(escalationDaysBeforeRaw, 10) || null
        : null;
      const complianceId = getCellStrMax(row, complianceIdCol, 255) || null;
      const documentInstanceId = getCellStrMax(row, documentInstanceIdCol, 255) || null;

      const assigneesStr = getCellStr(row, assignedToCol);
      const { userIds: assigneeIds, errors: assigneeErrors } = await resolveAssignees(
        client,
        organizationId,
        assigneesStr,
        assigneeCache
      );
      if (assigneeErrors.length > 0) {
        pushError({ sheet: tasksSheet.name, row: r, message: assigneeErrors.join('; ') });
        continue;
      }

      let taskCreatorId = userId;
      const taskOwnerStr = getCellStr(row, taskOwnerCol);
      if (taskOwnerStr) {
        const resolvedOwnerId = await resolveUserIdByMobileOrName(client, organizationId, taskOwnerStr);
        if (!resolvedOwnerId) {
          pushError({ sheet: tasksSheet.name, row: r, message: `Task owner not found: ${taskOwnerStr}` });
          continue;
        }
        taskCreatorId = resolvedOwnerId;
      }

      let reportingMemberId: string | null = null;
      const reportingMemberStr = getCellStr(row, reportingMemberCol);
      if (reportingMemberStr) {
        reportingMemberId = await resolveUserIdByMobileOrName(client, organizationId, reportingMemberStr);
        if (!reportingMemberId) {
          pushError({ sheet: tasksSheet.name, row: r, message: `Reporting member not found: ${reportingMemberStr}` });
          continue;
        }
      }

      let escalationContactIds: string[] = [];
      const escalationContactsStr = getCellStr(row, escalationContactsCol);
      if (escalationContactsStr) {
        const { userIds, errors } = await resolveAssignees(
          client,
          organizationId,
          escalationContactsStr,
          assigneeCache
        );
        if (errors.length > 0) {
          pushError({ sheet: tasksSheet.name, row: r, message: errors.join('; ') });
          continue;
        }
        escalationContactIds = userIds;
      }

    // Task Tag is treated as client name in current product behavior.
    // Keep backward compatibility: prefer explicit Client Name column,
    // otherwise use the Tags column as the client name input.
    let clientEntityId: string | null = null;
    const clientName = getCellStrMax(row, clientNameCol, 255) || tagsText || null;
    if (clientName) {
      const ce = await client.query(
        'SELECT id FROM client_entities WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
        [organizationId, clientName]
      );
      clientEntityId = ce.rows?.[0]?.id ?? null;
      if (!clientEntityId) {
        pushError({ sheet: tasksSheet.name, row: r, message: `Client not found: ${clientName}` });
        continue;
      }
    }

      let frequency: string | null = null;
      let recurrenceType: string | null = null;
      let recurrenceInterval = 1;
      let specificWeekday: number | null = null;
      let nextRecurrenceDate: Date | null = null;
      const recurrenceRaw = getCellStr(row, recurrenceCol).toLowerCase();
      if (taskType === 'recurring') {
        if (!recurrenceRaw) {
          pushError({ sheet: tasksSheet.name, row: r, message: 'Recurrence is required for recurring tasks' });
          continue;
        }
        if (
          (recurrenceRaw === 'yearly' || recurrenceRaw === 'annually') &&
          accountingYearStartForOrg === undefined
        ) {
          accountingYearStartForOrg = await loadOrganizationAccountingYearStart(client, organizationId);
        }
        const schedule = resolveBulkRecurrenceSchedule(recurrenceRaw, {
          startDate,
          dueDate,
          recurrenceInterval,
          accountingYearStart: accountingYearStartForOrg,
        });
        if (!schedule) {
          pushError({
            sheet: tasksSheet.name,
            row: r,
            message: `Invalid recurrence: ${recurrenceRaw}. Use Daily, Weekly, Monthly, Quarterly, or Yearly.`,
          });
          continue;
        }
        frequency = schedule.frequency;
        recurrenceType = schedule.recurrenceType;
        specificWeekday = schedule.specificWeekday;
        nextRecurrenceDate = schedule.nextRecurrenceDate;
      }

      const allAssigneeIds = new Set<string>(assigneeIds);
      allAssigneeIds.add(taskCreatorId);
      const isDifferentOwner = taskCreatorId !== userId;
      if (isDifferentOwner) {
        allAssigneeIds.delete(userId);
      }

      let escalationRules: any = autoEscalate ? { enabled: true } : null;
      if (autoEscalate && escalationTrigger) {
        escalationRules = {
          ...(escalationRules || {}),
          trigger: escalationTrigger,
        };
      }
      if (autoEscalate && escalationDaysBefore != null) {
        escalationRules = {
          ...(escalationRules || {}),
          days_before: escalationDaysBefore,
        };
      }
      if (autoEscalate && escalationContactIds.length > 0) {
        escalationRules = {
          ...(escalationRules || {}),
          contact_ids: escalationContactIds,
        };
      }
      if (isDifferentOwner && escalationRules) {
        escalationRules = {
          ...escalationRules,
          _metadata: {
            original_creator_id: userId,
            task_creator_id: taskCreatorId,
          },
        };
      }

      const payload: TaskBulkJobPayload = {
        title,
        clientName: clientName || null,
        clientEntityId,
        description,
        taskType,
        startDate: startDate ? formatBulkDateOnly(startDate) : null,
        targetDate: targetDate ? formatBulkDateOnly(targetDate) : null,
        dueDate: formatBulkDateOnly(dueDate),
        frequency,
        recurrenceType,
        recurrenceInterval,
        specificWeekday,
        nextRecurrenceDate: nextRecurrenceDate ? serializeBulkRecurrenceCursor(nextRecurrenceDate) : null,
        taskRolloutType,
        recurrenceEndType,
        recurrenceEndDate,
        recurrenceAfterOccurrences,
        assigneeIds,
        taskCreatorId,
        reportingMemberId,
        parsedFinancialValue,
        autoEscalate,
        escalationTrigger,
        escalationDaysBefore,
        escalationContactIds,
        escalationRules,
        complianceId,
        documentInstanceId,
        allAssigneeIds: Array.from(allAssigneeIds),
        isDifferentOwner,
        sourceRowIndex: r,
        idempotencyKey: createHash('sha256')
          .update(
            JSON.stringify({
              sourceRowIndex: r,
              organizationId,
              userId,
              title,
              clientName: clientName || null,
              clientEntityId,
              description,
              tagsText,
              taskType,
              startDate: startDate ? formatBulkDateOnly(startDate) : null,
              targetDate: targetDate ? formatBulkDateOnly(targetDate) : null,
              dueDate: formatBulkDateOnly(dueDate),
              frequency,
              specificWeekday,
              nextRecurrenceDate: nextRecurrenceDate
                ? serializeBulkRecurrenceCursor(nextRecurrenceDate)
                : null,
              taskRolloutType,
              recurrenceEndType,
              recurrenceEndDate,
              recurrenceAfterOccurrences,
              taskCreatorId,
              reportingMemberId,
              parsedFinancialValue,
              autoEscalate,
              escalationTrigger,
              escalationDaysBefore,
              escalationContactIds: [...escalationContactIds].sort(),
              complianceId,
              documentInstanceId,
              allAssigneeIds: Array.from(allAssigneeIds).sort(),
            })
          )
          .digest('hex'),
      };

      const { inserted } = await createTaskFromPayload(client, payload, organizationId, userId);
      if (inserted) result.updated.tasks += 1;
    } catch (err: any) {
      console.log('[TaskBulk] row error', r, err?.message);
      pushError({
        sheet: tasksSheet.name,
        row: r,
        message: err?.message || 'Failed to create task',
      });
    }
  }

  console.log('[TaskBulk] parseAndApply done', {
    tasksCreated: result.updated.tasks,
    errorCount: result.errors.length,
    firstErrors: result.errors.slice(0, 5),
  });
  return result;
  } finally {
    client.release();
  }
}
