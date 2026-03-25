import ExcelJS from 'exceljs';
import { createHash } from 'crypto';
import { getClient } from '../config/database';
import type { TaskBulkJobPayload } from './taskBulkService';

const MAX_ROWS_PER_SHEET = 500;
const MAX_ERRORS_REPORTED = 100;
const TITLE_MAX = 500;
const STRING_MAX = 500;

export interface TaskBulkEnqueueResult {
  uploadId: string;
  totalRows: number;
  status: 'queued';
  validationErrors?: Array<{ sheet?: string; row?: number; message: string }>;
}

export interface TaskBulkUploadStatus {
  totalRows: number;
  status: string;
  processedCount: number;
  failedCount: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  errors?: Array<{ rowIndex: number; message: string }>;
}

/** Resolve user ID by mobile */
async function resolveUserIdByMobile(client: any, mobile: string): Promise<string | null> {
  if (!mobile) return null;
  let normalized = (mobile || '').trim().replace(/\s/g, '');
  if (!normalized) return null;
  let digits = normalized.replace(/\D/g, '');
  if (digits.length > 12) {
    digits = digits.slice(0, 10);
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
  if (trimmed.includes('@')) {
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
      errors.push(`Assignee not found: ${part}`);
    }
  }
  return { userIds, errors };
}

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
    if (Number.isInteger(val)) return String(val);
    return val.toFixed(0);
  }
  if (val instanceof Date) return toLocalDateOnlyString(val);
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

/**
 * Parse Excel buffer and enqueue one job per valid row. Returns uploadId and totalRows.
 */
export async function enqueueTaskBulkUpload(
  buffer: Buffer,
  filename: string,
  userId: string,
  organizationId: string
): Promise<TaskBulkEnqueueResult> {
  const validationErrors: Array<{ sheet?: string; row?: number; message: string }> = [];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);

  const tasksSheet = workbook.getWorksheet('Tasks') || workbook.worksheets[0];
  if (!tasksSheet || (tasksSheet.rowCount ?? 0) < 2) {
    throw new Error('No "Tasks" sheet found or sheet has no data rows.');
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
    // Optional (template may omit); keep for backward compatibility with older files.
    const autoEscalateCol = col('auto escalate|auto_escalate');

    if (titleCol < 0 || dueDateCol < 0) {
      throw new Error('Missing required columns: Title and Due Date');
    }

    const maxRow = Math.min(tasksSheet.rowCount ?? 0, MAX_ROWS_PER_SHEET + 1);
    const jobs: { row_index: number; payload: TaskBulkJobPayload }[] = [];

    for (let r = 2; r <= maxRow; r++) {
      try {
        const row = tasksSheet.getRow(r);
        if (isRowEmpty(row, [titleCol, dueDateCol])) continue;

        const title = getCellStrMax(row, titleCol, TITLE_MAX);
        if (!title) {
          validationErrors.push({ sheet: tasksSheet.name, row: r, message: 'Title is required' });
          continue;
        }

        const dueDateVal = getCellStr(row, dueDateCol);
        const dueDate = parseDate(dueDateVal);
        if (!dueDate) {
          const msg = !dueDateVal || !dueDateVal.trim()
            ? 'Due date is required'
            : `Invalid due date: ${dueDateVal} (use YYYY-MM-DD or DD/MM/YYYY)`;
          validationErrors.push({ sheet: tasksSheet.name, row: r, message: msg });
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

        const autoEscalateStr = autoEscalateCol >= 0 ? getCellStr(row, autoEscalateCol).toLowerCase() : '';
        const autoEscalate = autoEscalateStr === 'yes' || autoEscalateStr === 'true' || autoEscalateStr === '1';

        const assigneesStr = getCellStr(row, assignedToCol);
        const { userIds: assigneeIds, errors: assigneeErrors } = await resolveAssignees(
          client,
          organizationId,
          assigneesStr,
          assigneeCache
        );
        if (assigneeErrors.length > 0) {
          validationErrors.push({ sheet: tasksSheet.name, row: r, message: assigneeErrors.join('; ') });
          continue;
        }

        let taskCreatorId = userId;
        const taskOwnerStr = getCellStr(row, taskOwnerCol);
        if (taskOwnerStr) {
          const resolvedOwnerId = await resolveUserIdByMobileOrName(client, organizationId, taskOwnerStr);
          if (!resolvedOwnerId) {
            validationErrors.push({ sheet: tasksSheet.name, row: r, message: `Task owner not found: ${taskOwnerStr}` });
            continue;
          }
          taskCreatorId = resolvedOwnerId;
        }

        let reportingMemberId: string | null = null;
        const reportingMemberStr = getCellStr(row, reportingMemberCol);
        if (reportingMemberStr) {
          reportingMemberId = await resolveUserIdByMobileOrName(client, organizationId, reportingMemberStr);
          if (!reportingMemberId) {
            validationErrors.push({ sheet: tasksSheet.name, row: r, message: `Reporting member not found: ${reportingMemberStr}` });
            continue;
          }
          if (assigneeIds.length > 0 && !assigneeIds.includes(reportingMemberId)) {
            validationErrors.push({ sheet: tasksSheet.name, row: r, message: 'Reporting member must be one of the assignees' });
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
            validationErrors.push({ sheet: tasksSheet.name, row: r, message: `Client not found: ${clientName}` });
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

        let escalationRules: object | null = autoEscalate ? { enabled: true } : null;
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

        jobs.push({ row_index: r, payload });
      } catch (err: any) {
        validationErrors.push({ sheet: tasksSheet.name, row: r, message: err?.message || 'Failed to build row payload' });
      }
    }

    if (jobs.length === 0) {
      throw new Error(
        validationErrors.length > 0
          ? `No valid rows to enqueue. First error: ${validationErrors[0].message}`
          : 'No data rows found in Tasks sheet.'
      );
    }

    const uploadResult = await client.query(
      `INSERT INTO task_bulk_uploads (organization_id, created_by, filename, total_rows, status)
       VALUES ($1, $2, $3, $4, 'queued')
       RETURNING id`,
      [organizationId, userId, filename.slice(0, 255), jobs.length]
    );
    const uploadId = uploadResult.rows[0].id;

    for (const { row_index, payload } of jobs) {
      await client.query(
        `INSERT INTO task_bulk_jobs (upload_id, row_index, status, payload)
         VALUES ($1, $2, 'pending', $3)`,
        [uploadId, row_index, JSON.stringify(payload)]
      );
    }

    return {
      uploadId,
      totalRows: jobs.length,
      status: 'queued',
      validationErrors: validationErrors.length > 0 ? validationErrors.slice(0, MAX_ERRORS_REPORTED) : undefined,
    };
  } finally {
    client.release();
  }
}

/**
 * Get status for a task bulk upload. Returns null if not found or wrong organization.
 */
export async function getUploadStatus(
  uploadId: string,
  organizationId: string
): Promise<TaskBulkUploadStatus | null> {
  const client = await getClient();
  try {
    const uploadResult = await client.query(
      `SELECT total_rows, status, processed_count, failed_count, created_at, updated_at, completed_at
       FROM task_bulk_uploads
       WHERE id = $1 AND organization_id = $2`,
      [uploadId, organizationId]
    );
    if (uploadResult.rows.length === 0) return null;

    const row = uploadResult.rows[0];
    let errors: Array<{ rowIndex: number; message: string }> | undefined;
    const failedJobsResult = await client.query(
      `SELECT row_index, error_message FROM task_bulk_jobs
       WHERE upload_id = $1 AND status = 'failed'
       ORDER BY row_index ASC LIMIT 100`,
      [uploadId]
    );
    if (failedJobsResult.rows.length > 0) {
      errors = failedJobsResult.rows.map((r: any) => ({
        rowIndex: r.row_index,
        message: r.error_message || 'Unknown error',
      }));
    }

    return {
      totalRows: row.total_rows,
      status: row.status,
      processedCount: row.processed_count,
      failedCount: row.failed_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      errors,
    };
  } finally {
    client.release();
  }
}

/**
 * Cancel a task bulk upload and its pending jobs.
 */
export async function cancelUpload(uploadId: string, organizationId: string): Promise<boolean> {
  const client = await getClient();
  try {
    const result = await client.query(
      `UPDATE task_bulk_uploads SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND status IN ('queued', 'processing')
       RETURNING id`,
      [uploadId, organizationId]
    );
    if (result.rows.length === 0) return false;
    await client.query(
      `UPDATE task_bulk_jobs SET status = 'cancelled', updated_at = NOW()
       WHERE upload_id = $1 AND status = 'pending'`,
      [uploadId]
    );
    return true;
  } finally {
    client.release();
  }
}
