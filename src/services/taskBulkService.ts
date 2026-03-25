import ExcelJS from 'exceljs';
import { getClient } from '../config/database';
import { createHash } from 'crypto';

/** Bulk upload limits and safety */
const MAX_ROWS_PER_SHEET = 500;
const MAX_ERRORS_REPORTED = 100;
const TITLE_MAX = 500;
const STRING_MAX = 500;

export interface TaskBulkUploadResult {
  updated: { tasks: number };
  errors: Array<{ sheet?: string; row?: number; message: string }>;
}

// --- New: Optional masters in the same workbook (backward compatible) ---
// These sheets are optional. If present, they are processed before Tasks.
// Sheet names supported:
// - Cost Center (new) or Cost Centres (existing in OrgIt Settings template)
// - Branch (new) or Branches (existing in OrgIt Settings template)
const COST_CENTER_SHEET_NAMES = ['Cost Center', 'Cost Centres'];
const BRANCH_SHEET_NAMES = ['Branch', 'Branches'];
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
  const r = await client.query(
    `SELECT uo.user_id FROM user_organizations uo
     JOIN users u ON u.id = uo.user_id
     WHERE uo.organization_id = $1 AND LOWER(TRIM(u.name)) = LOWER($2)
     LIMIT 1`,
    [organizationId, trimmed]
  );
  return r.rows.length > 0 ? r.rows[0].user_id : null;
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

const addMonthsClamped = (date: Date, monthsToAdd: number): Date => {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const target = new Date(year, month + monthsToAdd, 1);
  const daysInTargetMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const clampedDay = Math.min(day, daysInTargetMonth);
  const next = new Date(target.getFullYear(), target.getMonth(), clampedDay);
  next.setHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  return next;
};

function calculateNextRecurrenceDate(
  frequency: 'weekly' | 'monthly' | 'quarterly' | 'yearly' | 'specific_weekday',
  specificWeekday: number | null,
  baseDate: Date
): Date {
  const base = new Date(baseDate);
  const next = new Date(base);
  switch (frequency) {
    case 'weekly':
      next.setDate(next.getDate() + 7);
      return next;
    case 'monthly':
      return addMonthsClamped(base, 1);
    case 'quarterly':
      return addMonthsClamped(base, 3);
    case 'yearly':
      return addMonthsClamped(base, 12);
    case 'specific_weekday': {
      if (specificWeekday == null) return next;
      const current = next.getDay();
      const daysUntilNext = (specificWeekday - current + 7) % 7 || 7;
      next.setDate(next.getDate() + daysUntilNext);
      return next;
    }
    default:
      return next;
  }
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

async function upsertCostCentresFromSheet(
  client: any,
  workbook: ExcelJS.Workbook,
  organizationId: string,
  pushError: (err: { sheet?: string; row?: number; message: string }) => void
): Promise<void> {
  const sheet = getWorksheetByNames(workbook, COST_CENTER_SHEET_NAMES);
  if (!sheet || (sheet.rowCount ?? 0) < 2) return; // optional

  const headers = sheet.getRow(1).values as any[];
  const orgNameIdx = colAny(headers, 'organization_name');
  const nameIdx = colAny(headers, 'name');
  const shortNameIdx = colAny(headers, 'short_name');
  const displayOrderIdx = colAny(headers, 'display_order');

  if (nameIdx < 0) {
    pushError({ sheet: sheet.name, message: 'Missing required column: name' });
    return;
  }

  const maxRow = Math.min(sheet.rowCount ?? 0, MAX_ROWS_PER_SHEET + 1);
  for (let r = 2; r <= maxRow; r++) {
    const row = sheet.getRow(r);
    if (isRowEmpty(row, [nameIdx])) continue;

    // Admin task bulk upload is scoped to the uploader org. If organization_name is present and mismatched, skip gracefully.
    const orgName = orgNameIdx >= 0 ? getCellStr(row, orgNameIdx) : '';
    if (orgName) {
      pushError({
        sheet: sheet.name,
        row: r,
        message: 'organization_name is ignored for Task bulk upload (scoped to current organization)',
      });
    }

    const name = getCellStrMax(row, nameIdx, 255);
    if (!name) {
      pushError({ sheet: sheet.name, row: r, message: 'Cost Center name is required' });
      continue;
    }

    const short_name = shortNameIdx >= 0 ? getCellStrMax(row, shortNameIdx, 100) : '';
    const display_order_raw = displayOrderIdx >= 0 ? getCellStr(row, displayOrderIdx) : '';
    const display_order = display_order_raw ? parseInt(display_order_raw, 10) : 0;

    try {
      await client.query(
        `INSERT INTO cost_centres (organization_id, name, short_name, display_order)
         VALUES ($1, $2, NULLIF($3, ''), $4)
         ON CONFLICT (organization_id, name)
         DO UPDATE SET short_name = EXCLUDED.short_name, display_order = EXCLUDED.display_order, updated_at = CURRENT_TIMESTAMP`,
        [organizationId, name, short_name || '', Number.isFinite(display_order) ? display_order : 0]
      );
    } catch (e: any) {
      pushError({ sheet: sheet.name, row: r, message: e?.message || 'Failed to upsert cost centre' });
    }
  }
}

async function upsertBranchesFromSheet(
  client: any,
  workbook: ExcelJS.Workbook,
  organizationId: string,
  pushError: (err: { sheet?: string; row?: number; message: string }) => void
): Promise<void> {
  const sheet = getWorksheetByNames(workbook, BRANCH_SHEET_NAMES);
  if (!sheet || (sheet.rowCount ?? 0) < 2) return; // optional

  const headers = sheet.getRow(1).values as any[];
  const orgNameIdx = colAny(headers, 'organization_name');
  const nameIdx = colAny(headers, 'name');
  const shortNameIdx = colAny(headers, 'short_name');
  const addressIdx = colAny(headers, 'address');
  const gstIdx = colAny(headers, 'gst_number');

  if (nameIdx < 0) {
    pushError({ sheet: sheet.name, message: 'Missing required column: name' });
    return;
  }

  const maxRow = Math.min(sheet.rowCount ?? 0, MAX_ROWS_PER_SHEET + 1);
  for (let r = 2; r <= maxRow; r++) {
    const row = sheet.getRow(r);
    if (isRowEmpty(row, [nameIdx])) continue;

    const orgName = orgNameIdx >= 0 ? getCellStr(row, orgNameIdx) : '';
    if (orgName) {
      pushError({
        sheet: sheet.name,
        row: r,
        message: 'organization_name is ignored for Task bulk upload (scoped to current organization)',
      });
    }

    const name = getCellStrMax(row, nameIdx, 255);
    if (!name) {
      pushError({ sheet: sheet.name, row: r, message: 'Branch name is required' });
      continue;
    }

    const short_name = shortNameIdx >= 0 ? getCellStrMax(row, shortNameIdx, 100) : '';
    const address = addressIdx >= 0 ? getCellStrMax(row, addressIdx, 500) : '';
    const gst_number = gstIdx >= 0 ? getCellStrMax(row, gstIdx, 50) : '';

    try {
      // branches table doesn't enforce uniqueness by name, so we implement "upsert by org + lower(name)" safely.
      const existing = await client.query(
        'SELECT id FROM branches WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
        [organizationId, name]
      );
      if (existing.rows.length > 0) {
        await client.query(
          `UPDATE branches
           SET short_name = NULLIF($1, ''), address = NULLIF($2, ''), gst_number = NULLIF($3, ''), updated_at = CURRENT_TIMESTAMP
           WHERE id = $4`,
          [short_name || '', address || '', gst_number || '', existing.rows[0].id]
        );
      } else {
        await client.query(
          `INSERT INTO branches (organization_id, name, short_name, address, gst_number)
           VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''))`,
          [organizationId, name, short_name || '', address || '', gst_number || '']
        );
      }
    } catch (e: any) {
      pushError({ sheet: sheet.name, row: r, message: e?.message || 'Failed to upsert branch' });
    }
  }
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
  ];
  sheet.getRow(1).font = { bold: true };

  // Keep assignee / reporting / owner as text to avoid Excel number corruption.
  // Column indices are 1-based; note Client Name was inserted at column 2.
  sheet.getColumn(3).numFmt = '@'; // Assigned To
  sheet.getColumn(4).numFmt = '@'; // Reporting Member
  sheet.getColumn(10).numFmt = '@'; // Task Owner

  const taskTypeList = 'one_time,recurring';
  const recurrenceList = 'Weekly,Monthly,Quarterly,Yearly';
  // Task Type is now column H (after inserting Client Name).
  (sheet as any).dataValidations.add('H2:H1000', {
    type: 'list',
    allowBlank: true,
    formulae: [`"${taskTypeList}"`],
    showErrorMessage: true,
    errorTitle: 'Invalid value',
    error: 'Select one_time or recurring.',
  });
  // Recurrence is now column I.
  (sheet as any).dataValidations.add('I2:I1000', {
    type: 'list',
    allowBlank: true,
    formulae: [`"${recurrenceList}"`],
    showErrorMessage: true,
    errorTitle: 'Invalid value',
    error: 'Select Weekly, Monthly, Quarterly, or Yearly.',
  });

  // --- New sheets (optional on upload; keeps old files compatible) ---
  // Use DB-column headers for these masters to avoid ambiguity.
  const costCenterSheet = workbook.addWorksheet('Cost Center', {
    headerFooter: { firstHeader: 'OrgIt Task Bulk Upload - Cost Center' },
  });
  costCenterSheet.columns = [
    { header: 'organization_name', key: 'organization_name', width: 25 },
    { header: 'name', key: 'name', width: 25 },
    { header: 'short_name', key: 'short_name', width: 15 },
    { header: 'display_order', key: 'display_order', width: 14 },
  ];
  costCenterSheet.getRow(1).font = { bold: true };

  const branchSheet = workbook.addWorksheet('Branch', {
    headerFooter: { firstHeader: 'OrgIt Task Bulk Upload - Branch' },
  });
  branchSheet.columns = [
    { header: 'organization_name', key: 'organization_name', width: 25 },
    { header: 'name', key: 'name', width: 25 },
    { header: 'short_name', key: 'short_name', width: 15 },
    { header: 'address', key: 'address', width: 40 },
    { header: 'gst_number', key: 'gst_number', width: 20 },
  ];
  branchSheet.getRow(1).font = { bold: true };

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
  specificWeekday: number | null;
  nextRecurrenceDate: string | null;
  assigneeIds: string[];
  taskCreatorId: string;
  reportingMemberId: string | null;
  parsedFinancialValue: number | null;
  autoEscalate: boolean;
  escalationRules: object | null;
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
    specificWeekday,
    nextRecurrenceDate,
    taskCreatorId,
    reportingMemberId,
    parsedFinancialValue,
    autoEscalate,
    escalationRules,
    allAssigneeIds,
    isDifferentOwner,
    idempotencyKey,
  } = payload;

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

  const columnCheck = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'tasks'
     AND column_name IN ('created_by', 'creator_id', 'financial_value', 'finance_type', 'auto_escalate', 'escalation_rules', 'client_entity_id', 'client_name')`
  );
  const hasCreatedBy = columnCheck.rows.some((c: any) => c.column_name === 'created_by');
  const hasCreatorId = columnCheck.rows.some((c: any) => c.column_name === 'creator_id');
  const hasFinancialValue = columnCheck.rows.some((c: any) => c.column_name === 'financial_value');
  const hasFinanceType = columnCheck.rows.some((c: any) => c.column_name === 'finance_type');
  const hasAutoEscalate = columnCheck.rows.some((c: any) => c.column_name === 'auto_escalate');
  const hasEscalationRules = columnCheck.rows.some((c: any) => c.column_name === 'escalation_rules');
  const hasClientEntityId = columnCheck.rows.some((c: any) => c.column_name === 'client_entity_id');
  const hasClientName = columnCheck.rows.some((c: any) => c.column_name === 'client_name');

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
    taskType,
    organizationId,
    startDate || null,
    targetDate || null,
    dueDate,
    frequency,
    specificWeekday,
    nextRecurrenceDate || null,
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
  if (reportingMemberId) {
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

  const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(', ');
  const taskResult = await client.query(
    `INSERT INTO tasks (${insertCols.join(', ')})
     VALUES (${placeholders})
     RETURNING id`,
    insertVals
  );
  const task = taskResult.rows[0];

  const nowMs = Date.now();
  const startAtMs = startDate ? new Date(startDate as any).getTime() : null;
  const initialAssigneeStatus =
    startAtMs != null && Number.isFinite(startAtMs) && startAtMs > nowMs ? 'scheduled' : 'todo';

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
       ON CONFLICT (task_id, user_id) DO NOTHING`,
      [task.id, assigneeId, initialAssigneeStatus, role]
    );
  }

  const createdSuffix = ` with assignees - Pending acceptance${idempotencyKey ? ` [bulk_key:${idempotencyKey}]` : ''}`;
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
      `Task group auto-created by ${creatorName}`,
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
    try {
      await upsertCostCentresFromSheet(client, workbook, organizationId, pushError);
    } catch (e: any) {
      pushError({ sheet: 'Cost Center', message: e?.message || 'Failed to process Cost Center sheet' });
    }
    try {
      await upsertBranchesFromSheet(client, workbook, organizationId, pushError);
    } catch (e: any) {
      pushError({ sheet: 'Branch', message: e?.message || 'Failed to process Branch sheet' });
    }

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

      const autoEscalateStr = getCellStr(row, autoEscalateCol).toLowerCase();
      const autoEscalate = autoEscalateStr === 'yes' || autoEscalateStr === 'true' || autoEscalateStr === '1';

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
      if (assigneeIds.length > 0 && !assigneeIds.includes(reportingMemberId)) {
        pushError({
          sheet: tasksSheet.name,
          row: r,
          message: 'Reporting member must be one of the assignees',
        });
        continue;
      }
    }

    // Optional: Client Name -> resolve client_entities.id (scoped to org).
    // Backward compatible: if column is missing or blank, this stays null.
    let clientEntityId: string | null = null;
    const clientName = getCellStrMax(row, clientNameCol, 255);
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
      let specificWeekday: number | null = null;
      let nextRecurrenceDate: Date | null = null;
      const recurrenceRaw = getCellStr(row, recurrenceCol).toLowerCase();
      if (taskType === 'recurring' && recurrenceRaw) {
        const map: Record<string, string> = {
          weekly: 'specific_weekday',
          monthly: 'monthly',
          quarterly: 'quarterly',
          yearly: 'yearly',
        };
        frequency = map[recurrenceRaw] || null;
        if (recurrenceRaw === 'weekly') {
          specificWeekday = dueDate.getDay();
        } else if (recurrenceRaw === 'monthly') {
          specificWeekday = null;
        }
        if (frequency) {
          nextRecurrenceDate = calculateNextRecurrenceDate(
            frequency as any,
            specificWeekday,
            dueDate
          );
        }
      }

      const allAssigneeIds = new Set<string>(assigneeIds);
      allAssigneeIds.add(taskCreatorId);
      const isDifferentOwner = taskCreatorId !== userId;
      if (isDifferentOwner) {
        allAssigneeIds.delete(userId);
      }

      let escalationRules: any = autoEscalate ? { enabled: true } : null;
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
        startDate: startDate ? toLocalDateOnlyString(startDate) : null,
        targetDate: targetDate ? toLocalDateOnlyString(targetDate) : null,
        dueDate: toLocalDateOnlyString(dueDate),
        frequency,
        specificWeekday,
        nextRecurrenceDate: nextRecurrenceDate ? toLocalDateOnlyString(nextRecurrenceDate) : null,
        assigneeIds,
        taskCreatorId,
        reportingMemberId,
        parsedFinancialValue,
        autoEscalate,
        escalationRules,
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
              taskType,
              startDate: startDate ? toLocalDateOnlyString(startDate) : null,
              targetDate: targetDate ? toLocalDateOnlyString(targetDate) : null,
              dueDate: toLocalDateOnlyString(dueDate),
              frequency,
              specificWeekday,
              nextRecurrenceDate: nextRecurrenceDate ? toLocalDateOnlyString(nextRecurrenceDate) : null,
              taskCreatorId,
              reportingMemberId,
              parsedFinancialValue,
              autoEscalate,
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
