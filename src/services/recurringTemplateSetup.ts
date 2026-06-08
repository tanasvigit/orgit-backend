import {
  applyRecurrenceTimeOfDay,
  calculateNextCycleStartDate,
  startOfUtcCalendarDay,
} from './cycleStartRecurrence';
import { buildRecurrenceEndFieldsForStorage } from './recurrenceEndPolicy';
import { extractBaseTitle, syncRecurringTemplateMetadataFromTask } from './recurringTaskService';

type QueryExecutor = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

export const buildIntervalLiteralFromDates = (
  startInput?: string | Date | null,
  dueInput?: string | Date | null
): string => {
  if (!startInput || !dueInput) return '0 seconds';
  const start = new Date(startInput);
  const due = new Date(dueInput);
  if (Number.isNaN(start.getTime()) || Number.isNaN(due.getTime())) return '0 seconds';
  const diffMs = Math.max(0, due.getTime() - start.getTime());
  return `${Math.floor(diffMs / 1000)} seconds`;
};

export async function loadOrganizationAccountingYearStart(
  executor: QueryExecutor,
  organizationId: string | null | undefined
): Promise<string | null> {
  if (!organizationId) return null;
  const result = await executor.query(
    `SELECT accounting_year_start::text AS accounting_year_start
     FROM organizations
     WHERE id = $1
     LIMIT 1`,
    [organizationId]
  );
  const raw = result.rows[0]?.accounting_year_start;
  if (!raw) return null;
  return String(raw).split('T')[0] || null;
}

export type BulkRecurrenceSchedule = {
  frequency: string;
  recurrenceType: string;
  specificWeekday: number | null;
  nextRecurrenceDate: Date;
};

/** YYYY-MM-DD in UTC (bulk sheet date columns). */
export function formatBulkDateOnly(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Full ISO timestamp for template next_recurrence_date (preserves time). */
export function serializeBulkRecurrenceCursor(date: Date): string {
  return date.toISOString();
}

/** Parse bulk YYYY-MM-DD to timestamptz at 22:00 UTC (matches recurring job storage). */
export function parseBulkDateOnlyToInstant(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const m = String(dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 22, 0, 0, 0));
}

export function normalizeBulkNextRecurrenceForInsert(
  raw: string | null | undefined,
  recurrenceType: string | null
): string | null {
  if (!raw) return null;
  if (raw.includes('T')) return raw;
  if (recurrenceType === 'daily') {
    return parseBulkDateOnlyToInstant(raw)?.toISOString() ?? raw;
  }
  return raw;
}

export function resolveBulkRecurrenceSchedule(
  recurrenceRaw: string,
  options: {
    startDate: Date | null;
    dueDate: Date;
    recurrenceInterval?: number;
    accountingYearStart?: string | null;
  }
): BulkRecurrenceSchedule | null {
  const raw = recurrenceRaw.toLowerCase().trim();
  if (!raw) return null;

  const configs: Record<string, { frequency: string; recurrenceType: string }> = {
    daily: { frequency: 'daily', recurrenceType: 'daily' },
    weekly: { frequency: 'specific_weekday', recurrenceType: 'weekly' },
    monthly: { frequency: 'monthly', recurrenceType: 'monthly' },
    quarterly: { frequency: 'quarterly', recurrenceType: 'quarterly' },
    yearly: { frequency: 'yearly', recurrenceType: 'annually' },
    annually: { frequency: 'yearly', recurrenceType: 'annually' },
  };
  const config = configs[raw];
  if (!config) return null;

  let specificWeekday: number | null = null;
  if (raw === 'weekly') {
    specificWeekday = (options.startDate || options.dueDate).getUTCDay();
  }

  const cycleAnchorDate = options.startDate || options.dueDate;
  const normalizedAnchor =
    config.recurrenceType === 'daily' ? startOfUtcCalendarDay(cycleAnchorDate) : cycleAnchorDate;
  const interval = Math.max(1, Number(options.recurrenceInterval) || 1);
  const accountingYearStart =
    raw === 'yearly' || raw === 'annually' ? options.accountingYearStart ?? '2000-04-01' : null;

  let nextRecurrenceDate = calculateNextCycleStartDate(
    config.recurrenceType,
    interval,
    specificWeekday,
    normalizedAnchor,
    accountingYearStart
  );
  if (config.recurrenceType === 'daily') {
    const timeSource = options.startDate || options.dueDate;
    nextRecurrenceDate = applyRecurrenceTimeOfDay(nextRecurrenceDate, timeSource);
  }

  return {
    frequency: config.frequency,
    recurrenceType: config.recurrenceType,
    specificWeekday,
    nextRecurrenceDate,
  };
}

export type SetupRecurringTemplateInput = {
  task: Record<string, unknown>;
  organizationId: string | null;
  title: string;
  description?: string | null;
  category?: string | null;
  creatorId: string;
  reportingMemberId?: string | null;
  recurrenceType: string | null;
  recurrenceInterval?: number;
  recurrenceDayOfMonth?: number | null;
  specificWeekday?: number | null;
  nextRecurrenceDate: Date | string | null;
  recurrenceEndType?: string | null;
  recurrenceEndDate?: string | Date | null;
  recurrenceAfterOccurrences?: number | string | null;
  assigneeIds: Iterable<string>;
  escalationContactIds?: string[];
};

/** Create template row, link first instance, and persist template assignees. */
export async function setupRecurringTemplateForTask(
  client: QueryExecutor,
  input: SetupRecurringTemplateInput
): Promise<string | null> {
  const templatesTableCheck = await client.query(
    `SELECT to_regclass('public.task_recurrence_templates') AS exists`
  );
  if (!templatesTableCheck.rows[0]?.exists) {
    return null;
  }

  const templateAssigneesTableCheck = await client.query(
    `SELECT to_regclass('public.task_template_assignees') AS exists`
  );
  const templateAssigneesTableExists = !!templateAssigneesTableCheck.rows[0]?.exists;

  const templateColumnCheck = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'task_recurrence_templates'
       AND column_name IN (
         'base_target_offset',
         'recurrence_end_type',
         'recurrence_end_date',
         'recurrence_after_occurrences'
       )`
  );
  const hasBaseTargetOffset = templateColumnCheck.rows.some(
    (r) => r.column_name === 'base_target_offset'
  );
  const hasTemplateRecurrenceEndType = templateColumnCheck.rows.some(
    (r) => r.column_name === 'recurrence_end_type'
  );
  const hasTemplateRecurrenceEndDate = templateColumnCheck.rows.some(
    (r) => r.column_name === 'recurrence_end_date'
  );
  const hasTemplateRecurrenceAfterOccurrences = templateColumnCheck.rows.some(
    (r) => r.column_name === 'recurrence_after_occurrences'
  );

  const recurrenceEndStorage = buildRecurrenceEndFieldsForStorage(
    (input.recurrenceEndType as any) || 'never',
    input.recurrenceEndDate ?? null,
    input.recurrenceAfterOccurrences != null ? Number(input.recurrenceAfterOccurrences) : null
  );

  const templateEndColumns: string[] = [];
  const templateEndValues: unknown[] = [];
  if (hasTemplateRecurrenceEndType) {
    templateEndColumns.push('recurrence_end_type');
    templateEndValues.push(recurrenceEndStorage.recurrence_end_type);
  }
  if (hasTemplateRecurrenceEndDate) {
    templateEndColumns.push('recurrence_end_date');
    templateEndValues.push(recurrenceEndStorage.recurrence_end_date);
  }
  if (hasTemplateRecurrenceAfterOccurrences) {
    templateEndColumns.push('recurrence_after_occurrences');
    templateEndValues.push(recurrenceEndStorage.recurrence_after_occurrences);
  }
  const templateEndSql = templateEndColumns.length > 0 ? `, ${templateEndColumns.join(', ')}` : '';

  const taskId = String(input.task.id);
  const recurringBaseTitle = extractBaseTitle(String(input.title || ''));
  const recurrenceDate =
    input.task.start_date || input.task.created_at || new Date().toISOString();
  const baseTargetOffset =
    input.task.start_date && input.task.target_date
      ? buildIntervalLiteralFromDates(
          input.task.start_date as string,
          input.task.target_date as string
        )
      : null;
  const baseDueOffset = buildIntervalLiteralFromDates(
    input.task.start_date as string | Date | null,
    input.task.due_date as string | Date | null
  );
  const nextRecurrenceIso = input.nextRecurrenceDate
    ? new Date(input.nextRecurrenceDate).toISOString()
    : null;

  const templateBaseParamsWithTarget = [
    taskId,
    input.organizationId,
    recurringBaseTitle,
    input.description || null,
    input.category || null,
    input.creatorId,
    input.reportingMemberId || null,
    input.recurrenceType,
    input.recurrenceInterval || 1,
    input.recurrenceDayOfMonth || null,
    input.specificWeekday ?? null,
    recurrenceDate,
    baseTargetOffset,
    baseDueOffset,
    nextRecurrenceIso,
  ];
  const templateBaseParamsWithoutTarget = [
    taskId,
    input.organizationId,
    recurringBaseTitle,
    input.description || null,
    input.category || null,
    input.creatorId,
    input.reportingMemberId || null,
    input.recurrenceType,
    input.recurrenceInterval || 1,
    input.recurrenceDayOfMonth || null,
    input.specificWeekday ?? null,
    recurrenceDate,
    baseDueOffset,
    nextRecurrenceIso,
  ];
  const templateEndParamSql = (baseParamCount: number): string =>
    templateEndColumns.length > 0
      ? `, ${templateEndColumns.map((_, idx) => `$${baseParamCount + 1 + idx}`).join(', ')}`
      : '';

  const templateResult = hasBaseTargetOffset
    ? await client.query(
        `INSERT INTO task_recurrence_templates (
          task_id,
          organization_id,
          title,
          description,
          category,
          creator_id,
          reporting_member_id,
          recurrence_type,
          recurrence_interval,
          recurrence_day_of_month,
          specific_weekday,
          base_start_date,
          base_target_offset,
          base_due_offset,
          last_generated_at,
          next_recurrence_date,
          status${templateEndSql}
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::interval,$14::interval,NOW(),$15,'active'${templateEndParamSql(15)}
        )
        RETURNING id`,
        [...templateBaseParamsWithTarget, ...templateEndValues]
      )
    : await client.query(
        `INSERT INTO task_recurrence_templates (
          task_id,
          organization_id,
          title,
          description,
          category,
          creator_id,
          reporting_member_id,
          recurrence_type,
          recurrence_interval,
          recurrence_day_of_month,
          specific_weekday,
          base_start_date,
          base_due_offset,
          last_generated_at,
          next_recurrence_date,
          status${templateEndSql}
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::interval,NOW(),$14,'active'${templateEndParamSql(14)}
        )
        RETURNING id`,
        [...templateBaseParamsWithoutTarget, ...templateEndValues]
      );

  const templateId = templateResult.rows[0]?.id as string | undefined;
  if (!templateId) return null;

  await syncRecurringTemplateMetadataFromTask(client, templateId, input.task);

  const taskColumnCheck = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'tasks'
       AND column_name IN ('parent_task_id', 'recurrence_template_id', 'recurrence_instance_no')`
  );
  const hasParentTaskId = taskColumnCheck.rows.some((r) => r.column_name === 'parent_task_id');
  const hasRecurrenceTemplateId = taskColumnCheck.rows.some(
    (r) => r.column_name === 'recurrence_template_id'
  );
  const hasRecurrenceInstanceNo = taskColumnCheck.rows.some(
    (r) => r.column_name === 'recurrence_instance_no'
  );

  if (hasParentTaskId || hasRecurrenceTemplateId || hasRecurrenceInstanceNo) {
    const updates: string[] = [];
    const updateValues: unknown[] = [];
    let pIdx = 1;
    if (hasParentTaskId) {
      updates.push(`parent_task_id = $${pIdx++}`);
      updateValues.push(templateId);
    }
    if (hasRecurrenceTemplateId) {
      updates.push(`recurrence_template_id = $${pIdx++}`);
      updateValues.push(templateId);
    }
    if (hasRecurrenceInstanceNo) {
      updates.push(`recurrence_instance_no = $${pIdx++}`);
      updateValues.push(1);
    }
    updateValues.push(taskId);
    await client.query(`UPDATE tasks SET ${updates.join(', ')} WHERE id = $${pIdx}`, updateValues);
  }

  if (templateAssigneesTableExists) {
    const assigneeSet = new Set(Array.from(input.assigneeIds).filter(Boolean).map(String));
    if (assigneeSet.size === 0) assigneeSet.add(String(input.creatorId));

    for (const assigneeId of assigneeSet) {
      const role =
        String(assigneeId) === String(input.creatorId)
          ? 'creator'
          : input.reportingMemberId && String(assigneeId) === String(input.reportingMemberId)
          ? 'reporting_member'
          : 'member';
      await client.query(
        `INSERT INTO task_template_assignees (template_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (template_id, user_id) DO NOTHING`,
        [templateId, assigneeId, role]
      );
    }

    for (const escalationUserId of input.escalationContactIds || []) {
      if (!escalationUserId) continue;
      await client.query(
        `INSERT INTO task_template_assignees (template_id, user_id, role)
         VALUES ($1, $2, 'escalation_contact')
         ON CONFLICT (template_id, user_id) DO UPDATE
         SET role = EXCLUDED.role`,
        [templateId, escalationUserId]
      );
    }
  }

  return templateId;
}
