import { query } from '../config/database';
import { parseRecurrenceEndPolicy, shouldGenerateRecurrenceCycle } from './recurrenceEndPolicy';
import {
  advanceRecurrenceCycleCursor,
  getDailyLogicalInstanceDaySql,
  getExistingInstanceMatchSql,
  getRecurrenceCatchupLimit,
  resolveDailyLogicalInstanceDay,
  resolveInstanceStartDate,
  shouldContinueRecurrenceCatchup,
} from './recurrenceCycleUtils';
import { loadOrganizationAccountingYearStart } from './recurringTemplateSetup';
import {
  addUtcCalendarDays,
  applyRecurrenceTimeOfDay,
  normalizeCycleRecurrenceFrequency,
  startOfUtcCalendarDay,
} from './cycleStartRecurrence';
import { logTaskActivity } from './taskActivityLogger';
import { dispatchNotification } from './notification-bus.service';
import { resolveInitialAssigneeStatus } from './userTaskLifecycle';

const MONTH_ABBREVS = new Set([
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]);

/** Fields copied from anchor / prior instances onto each generated instance. */
const SOURCE_INSTANCE_COPY_FIELDS = [
  'compliance_id',
  'document_instance_id',
  'document_id',
  'client_entity_id',
  'client_name',
  'auto_escalate',
  'escalation_rules',
  'escalation_status',
  'escalation_trigger',
  'escalation_days_before',
  'financial_value',
  'finance_type',
  'priority',
  'org_structure_node_id',
  'org_structure_level_key',
  'org_structure_path',
  'task_rollout_type',
  'category',
  'end_date',
] as const;

const INSTANCE_METADATA_FIELDS = [...SOURCE_INSTANCE_COPY_FIELDS] as const;

const TEMPLATE_METADATA_FIELDS = [
  'client_name',
  'client_entity_id',
  'org_structure_node_id',
  'org_structure_level_key',
  'org_structure_path',
] as const;

async function getTableColumnSet(tableName: string): Promise<Set<string>> {
  const result = await query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = $1`,
    [tableName]
  );
  return new Set(result.rows.map((row: { column_name: string }) => row.column_name));
}

async function getTaskColumnSet(): Promise<Set<string>> {
  return getTableColumnSet('tasks');
}

async function loadSourceTask(taskId: string | null | undefined): Promise<Record<string, any> | null> {
  if (!taskId) return null;
  const result = await query(`SELECT * FROM tasks WHERE id = $1 LIMIT 1`, [taskId]);
  return result.rows[0] || null;
}

function isMetadataFieldPopulated(field: string, raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (field === 'client_name' && typeof raw === 'string' && !raw.trim()) return false;
  return true;
}

/** First non-empty layer wins (anchor → enriched instance → template). */
export function mergeRecurrenceMetadataLayers(
  layers: Array<Record<string, any> | null | undefined>
): Record<string, any> {
  const merged: Record<string, any> = {};
  for (const field of INSTANCE_METADATA_FIELDS) {
    for (const layer of layers) {
      if (!layer) continue;
      const raw = layer[field];
      if (!isMetadataFieldPopulated(field, raw)) continue;
      if (isMetadataFieldPopulated(field, merged[field])) continue;
      merged[field] = raw;
    }
  }
  return merged;
}

/** Load anchor + best task row + template; merge so user-created fields always propagate. */
async function loadMergedRecurrenceInstanceMetadata(
  template: Record<string, any>
): Promise<Record<string, any>> {
  const layers: Record<string, any>[] = [];

  if (template.task_id) {
    const anchor = await loadSourceTask(template.task_id);
    if (anchor) layers.push(anchor);
  }

  const enrichedInstance = await query(
    `SELECT *
     FROM tasks
     WHERE recurrence_template_id = $1
        OR ($2::uuid IS NOT NULL AND id = $2::uuid)
     ORDER BY
       (
         CASE WHEN compliance_id IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN document_instance_id IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN document_id IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN financial_value IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN NULLIF(TRIM(COALESCE(client_name, '')), '') IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN org_structure_node_id IS NOT NULL THEN 1 ELSE 0 END
       ) DESC,
       COALESCE(recurrence_instance_no, 9999) ASC,
       created_at ASC
     LIMIT 1`,
    [template.id, template.task_id || null]
  );
  if (enrichedInstance.rows[0]) {
    layers.push(enrichedInstance.rows[0]);
  }

  layers.push(template);
  return mergeRecurrenceMetadataLayers(layers);
}

/** Persist tag/unit on template when columns exist (see migration 20260530140000). */
export async function syncRecurringTemplateMetadataFromTask(
  executor: { query: (text: string, values?: any[]) => Promise<any> },
  templateId: string,
  task: Record<string, any>
): Promise<void> {
  const templateColumns = await getTableColumnSet('task_recurrence_templates');
  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const field of TEMPLATE_METADATA_FIELDS) {
    if (!templateColumns.has(field)) continue;
    const raw = task[field];
    if (raw === undefined) continue;
    updates.push(`${field} = $${idx++}`);
    if (field === 'org_structure_path' && raw != null && typeof raw === 'object') {
      values.push(JSON.stringify(raw));
    } else {
      values.push(raw);
    }
  }

  if (updates.length === 0) return;

  values.push(templateId);
  await executor.query(
    `UPDATE task_recurrence_templates
     SET ${updates.join(', ')},
         updated_at = NOW()
     WHERE id = $${idx}`,
    values
  );
}

async function insertMessageStatus(messageId: string, userId: string): Promise<void> {
  try {
    await query(
      `INSERT INTO message_status (message_id, user_id, status, status_at)
       VALUES ($1, $2, 'sent', NOW())`,
      [messageId, userId]
    );
  } catch (error: any) {
    if (error.message && error.message.includes('created_at')) {
      await query(
        `INSERT INTO message_status (message_id, user_id, status, created_at)
         VALUES ($1, $2, 'sent', NOW())`,
        [messageId, userId]
      );
      return;
    }
    console.warn('[generateNextRecurrence] Could not create message_status entry:', error.message);
  }
}

type TemplateAssignee = { userId: string; role: string };

async function loadTemplateAssignees(
  templateId: string,
  sourceTaskId: string | null | undefined
): Promise<TemplateAssignee[]> {
  const assigneesResult = await query(
    `SELECT user_id, role FROM task_template_assignees WHERE template_id = $1`,
    [templateId]
  );
  const assignees: TemplateAssignee[] = assigneesResult.rows.map((row) => ({
    userId: String(row.user_id),
    role: (row.role as string | null) || 'member',
  }));
  const knownIds = new Set(assignees.map((a) => a.userId));

  if (sourceTaskId) {
    const escalationResult = await query(
      `SELECT user_id, role
       FROM task_assignees
       WHERE task_id = $1 AND role = 'escalation_contact'`,
      [sourceTaskId]
    );
    for (const row of escalationResult.rows) {
      const userId = String(row.user_id);
      if (!knownIds.has(userId)) {
        assignees.push({ userId, role: 'escalation_contact' });
        knownIds.add(userId);
      }
    }
  }

  return assignees;
}

function normalizeFieldForTaskInsert(
  field: string,
  raw: unknown,
  _sourceTask: Record<string, any>
): unknown {
  if (raw === undefined) return undefined;
  if (field === 'escalation_rules' && raw != null && typeof raw === 'object') {
    return JSON.stringify(raw);
  }
  if (field === 'org_structure_path' && raw != null) {
    if (typeof raw === 'object') return JSON.stringify(raw);
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return raw;
}

export function buildCopiedInstanceMetadata(
  mergedSource: Record<string, any>,
  columnSet: Set<string>
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};

  for (const field of INSTANCE_METADATA_FIELDS) {
    if (!columnSet.has(field)) continue;
    const raw = mergedSource[field];
    if (!isMetadataFieldPopulated(field, raw)) continue;

    const normalized = normalizeFieldForTaskInsert(field, raw, mergedSource);
    if (normalized === undefined) continue;
    picked[field] = normalized;
  }

  if (columnSet.has('escalation_status') && picked.escalation_status == null) {
    picked.escalation_status = 'none';
  }

  return picked;
}

function instanceFieldIsEmpty(field: string, raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (field === 'client_name' && typeof raw === 'string' && !raw.trim()) return true;
  return false;
}

async function backfillTemplateInstancesMissingMetadata(
  templateId: string,
  anchorTaskId: string | null,
  metadata: Record<string, unknown>,
  taskColumnSet: Set<string>
): Promise<void> {
  if (!metadata || Object.keys(metadata).length === 0) return;

  const instances = await query(
    `SELECT id
     FROM tasks
     WHERE recurrence_template_id = $1
        OR ($2::uuid IS NOT NULL AND id = $2::uuid)`,
    [templateId, anchorTaskId]
  );

  for (const row of instances.rows) {
    await backfillInstanceRecurrenceMetadata(String(row.id), metadata, taskColumnSet);
  }
}

async function backfillInstanceRecurrenceMetadata(
  instanceId: string,
  metadata: Record<string, unknown>,
  taskColumnSet: Set<string>
): Promise<void> {
  if (!metadata || Object.keys(metadata).length === 0) return;

  const current = await loadSourceTask(instanceId);
  if (!current) return;

  const updates: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const [field, value] of Object.entries(metadata)) {
    if (!taskColumnSet.has(field)) continue;
    if (!instanceFieldIsEmpty(field, current[field])) continue;
    updates.push(`${field} = $${idx++}`);
    values.push(value);
  }

  if (updates.length === 0) return;

  values.push(instanceId);
  await query(
    `UPDATE tasks
     SET ${updates.join(', ')},
         updated_at = NOW()
     WHERE id = $${idx}`,
    values
  );
}

async function emitRecurrenceRealtimeEvents(
  io: any | undefined,
  recipientIds: string[],
  payload: {
    taskId: string;
    conversationId: string | null;
    title: string;
    assigneeStatus: string;
  }
): Promise<void> {
  if (!io) return;
  const computedAt = new Date().toISOString();
  for (const recipientId of recipientIds) {
    io.to(`user_${recipientId}`).emit('task:recurrence_created', {
      taskId: payload.taskId,
      conversationId: payload.conversationId,
      title: payload.title,
      computedAt,
    });
    io.to(`user_${recipientId}`).emit('task:status_changed', {
      taskId: payload.taskId,
      userId: recipientId,
      toStatus: payload.assigneeStatus,
      computedAt,
    });
  }
}

async function notifyRecurrenceCreated(
  io: any | undefined,
  params: {
    taskId: string;
    taskTitle: string;
    conversationId: string | null;
    creatorId: string;
    creatorName: string;
    assigneeUserIds: string[];
    welcomeMessage: string;
  }
): Promise<void> {
  const assigneeRecipients = params.assigneeUserIds.filter(
    (id) => id && String(id) !== String(params.creatorId)
  );

  if (assigneeRecipients.length > 0) {
    try {
      await dispatchNotification({
        type: 'TASK_ASSIGNED',
        recipientIds: assigneeRecipients,
        title: 'New recurring task',
        body: `You have been assigned: ${params.taskTitle}`,
        refId: params.taskId,
        refType: 'task',
        channels: ['in_app'],
        io,
      });
    } catch (error: any) {
      console.warn('[generateNextRecurrence] TASK_ASSIGNED notification failed:', error?.message || error);
    }
  }

  if (params.conversationId && assigneeRecipients.length > 0) {
    try {
      await dispatchNotification({
        type: 'MESSAGE_RECEIVED',
        recipientIds: assigneeRecipients,
        title: 'New task message',
        body: params.welcomeMessage,
        refId: params.conversationId,
        refType: 'conversation',
        channels: ['in_app'],
        io,
      });
    } catch (error: any) {
      console.warn('[generateNextRecurrence] MESSAGE_RECEIVED notification failed:', error?.message || error);
    }
  }
}

/** Strip trailing cycle suffix so template title stays a stable base. */
export const extractBaseTitle = (title: string): string => {
  const t = (title || '').trim();
  if (!t) return t;
  const dashMonth = t.match(/^(.*)\s+[-–—]\s+([a-z]{3})\s*$/i);
  if (dashMonth) {
    const maybeMon = dashMonth[2].toLowerCase();
    if (MONTH_ABBREVS.has(maybeMon)) {
      return dashMonth[1].trim() || t;
    }
  }
  const dailySuffix = t.match(/^(.*)\s+(\d{1,2})\s+([a-z]{3})\s*$/i);
  if (dailySuffix) {
    const maybeMon = dailySuffix[3].toLowerCase();
    if (MONTH_ABBREVS.has(maybeMon)) {
      return dailySuffix[1].trim() || t;
    }
  }
  const parts = t.split(/\s+/);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1].toLowerCase().replace(/\.$/, '');
    if (last.length === 3 && MONTH_ABBREVS.has(last)) {
      return parts.slice(0, -1).join(' ').trim() || t;
    }
  }
  return t;
};

/** Stored title is the stable base only; period is shown separately in the UI. */
export const formatRecurringTitle = (
  title: string,
  _cycleStartDate?: Date,
  _recurrenceType?: string | null
): string => extractBaseTitle(title);

export const parsePgIntervalToMs = (value: unknown): number => {
  if (value == null) return 0;
  if (typeof value === 'object') {
    const raw = value as Record<string, any>;
    const days = Number(raw.days ?? raw.day ?? 0);
    const hours = Number(raw.hours ?? raw.hour ?? 0);
    const minutes = Number(raw.minutes ?? raw.minute ?? 0);
    const seconds = Number(raw.seconds ?? raw.second ?? 0);
    const milliseconds = Number(raw.milliseconds ?? raw.millisecond ?? 0);
    if ([days, hours, minutes, seconds, milliseconds].some((n) => !Number.isNaN(n))) {
      return (
        (Number.isNaN(days) ? 0 : days) * 24 * 60 * 60 * 1000 +
        (Number.isNaN(hours) ? 0 : hours) * 60 * 60 * 1000 +
        (Number.isNaN(minutes) ? 0 : minutes) * 60 * 1000 +
        (Number.isNaN(seconds) ? 0 : seconds) * 1000 +
        (Number.isNaN(milliseconds) ? 0 : milliseconds)
      );
    }
  }
  const asString = String(value);
  const dayMatch = asString.match(/(-?\d+)\s+day/);
  const hourMatch = asString.match(/(-?\d+):(\d+):(\d+)/);
  let ms = 0;
  if (dayMatch) ms += Number(dayMatch[1]) * 24 * 60 * 60 * 1000;
  if (hourMatch) {
    ms += Number(hourMatch[1]) * 60 * 60 * 1000;
    ms += Number(hourMatch[2]) * 60 * 1000;
    ms += Number(hourMatch[3]) * 1000;
  }
  if (!dayMatch && !hourMatch && asString.includes('sec')) {
    const secMatch = asString.match(/(-?\d+(?:\.\d+)?)\s*sec/);
    if (secMatch) ms += Number(secMatch[1]) * 1000;
  }
  return ms;
};

const normalizeTemplateFrequency = (
  recurrenceType: string | null,
  specificWeekday: number | null
): any => {
  const normalized = String(recurrenceType || '').toLowerCase().trim();
  if (normalized === 'daily') return 'daily';
  if (normalized === 'weekly') {
    return specificWeekday === null || specificWeekday === undefined ? 'weekly' : 'specific_weekday';
  }
  if (normalized === 'monthly') return 'monthly';
  if (normalized === 'quarterly') return 'quarterly';
  if (normalized === 'annually' || normalized === 'yearly') return 'yearly';
  return 'monthly';
};

async function completeRecurrenceTemplate(templateId: string): Promise<void> {
  await query(
    `UPDATE task_recurrence_templates
     SET status = 'completed',
         next_recurrence_date = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [templateId]
  );
}

async function countTemplateInstances(templateId: string, anchorTaskId: string | null): Promise<number> {
  const res = await query(
    `SELECT COUNT(*)::int AS cnt
     FROM tasks
     WHERE recurrence_template_id = $1
        OR ($2::uuid IS NOT NULL AND id = $2::uuid)`,
    [templateId, anchorTaskId]
  );
  return Number(res.rows[0]?.cnt ?? 0);
}

function resolveRecurrenceTimeSource(template: Record<string, any>): Date {
  if (template.base_start_date) {
    return new Date(template.base_start_date);
  }
  return new Date();
}

/**
 * When the stored cursor races ahead of missing instance days (daily eve-before storage),
 * rewind to the eve-before cursor for the first gap so catch-up can materialize skipped days.
 */
async function repairDailyRecurrenceCursorIfSkewed(
  template: Record<string, any>
): Promise<Date | null> {
  if (String(template.recurrence_type || '').toLowerCase() !== 'daily') {
    return null;
  }
  if (!template.next_recurrence_date) {
    return null;
  }

  const missingResult = await query(
    `WITH series AS (
       SELECT generate_series(
         (SELECT (base_start_date AT TIME ZONE 'UTC')::date + 1 FROM task_recurrence_templates WHERE id = $1),
         (NOW() AT TIME ZONE 'UTC')::date,
         '1 day'::interval
       )::date AS d
     )
     SELECT s.d::text AS missing_day
     FROM series s
     WHERE NOT EXISTS (
       SELECT 1 FROM tasks t
       WHERE t.recurrence_template_id = $1
         AND ${getDailyLogicalInstanceDaySql('t.start_date')} = s.d
     )
     ORDER BY s.d
     LIMIT 1`,
    [template.id]
  );

  const missingDayRaw = missingResult.rows[0]?.missing_day;
  if (!missingDayRaw) {
    return null;
  }

  const missingDay = startOfUtcCalendarDay(new Date(`${missingDayRaw}T00:00:00.000Z`));
  const storedCursorLogicalDay = resolveDailyLogicalInstanceDay(
    new Date(template.next_recurrence_date)
  );
  if (storedCursorLogicalDay.getTime() <= missingDay.getTime()) {
    return null;
  }

  const timeSource = resolveRecurrenceTimeSource(template);
  const repairedCursor = applyRecurrenceTimeOfDay(
    addUtcCalendarDays(missingDay, -1),
    timeSource
  );

  await query(
    `UPDATE task_recurrence_templates
     SET next_recurrence_date = $1,
         updated_at = NOW()
     WHERE id = $2`,
    [repairedCursor, template.id]
  );

  console.warn(
    `[generateNextRecurrence] Rewound daily template ${template.id} cursor from ${template.next_recurrence_date} to ${repairedCursor.toISOString()} (first missing day ${missingDayRaw})`
  );

  return repairedCursor;
}

/**
 * Generate next occurrence for recurring tasks
 */
export const generateNextRecurrence = async (io?: any): Promise<void> => {
  const tableCheck = await query(
    `SELECT to_regclass('public.task_recurrence_templates') AS table_name`,
    []
  );
  if (!tableCheck.rows[0]?.table_name) {
    return;
  }

  const taskColumnSet = await getTaskColumnSet();

  const activeTemplates = await query(
    `SELECT * FROM task_recurrence_templates WHERE status = 'active'`,
    []
  );
  for (const activeTemplate of activeTemplates.rows) {
    const mergedForBackfill = await loadMergedRecurrenceInstanceMetadata(activeTemplate);
    const copiedForBackfill = buildCopiedInstanceMetadata(mergedForBackfill, taskColumnSet);
    if (Object.keys(copiedForBackfill).length > 0) {
      await syncRecurringTemplateMetadataFromTask({ query }, activeTemplate.id, mergedForBackfill);
      await backfillTemplateInstancesMissingMetadata(
        activeTemplate.id,
        activeTemplate.task_id ? String(activeTemplate.task_id) : null,
        copiedForBackfill,
        taskColumnSet
      );
    }
  }

  const dailyTemplatesForRepair = await query(
    `SELECT * FROM task_recurrence_templates
     WHERE status = 'active'
       AND LOWER(recurrence_type) = 'daily'`,
    []
  );
  for (const dailyTemplate of dailyTemplatesForRepair.rows) {
    await repairDailyRecurrenceCursorIfSkewed(dailyTemplate);
  }

  const result = await query(
    `SELECT *
     FROM task_recurrence_templates
     WHERE status = 'active'
       AND next_recurrence_date IS NOT NULL
       AND (
         (
           LOWER(recurrence_type) = 'daily'
           AND (
             CASE
               WHEN EXTRACT(HOUR FROM next_recurrence_date AT TIME ZONE 'UTC') = 22
                AND EXTRACT(MINUTE FROM next_recurrence_date AT TIME ZONE 'UTC') = 0
                AND EXTRACT(SECOND FROM next_recurrence_date AT TIME ZONE 'UTC') = 0
               THEN (next_recurrence_date AT TIME ZONE 'UTC')::date + 1
               ELSE (next_recurrence_date AT TIME ZONE 'UTC')::date
             END
           ) <= (NOW() AT TIME ZONE 'UTC')::date
         )
         OR (
           LOWER(recurrence_type) <> 'daily'
           AND next_recurrence_date <= NOW()
         )
       )
     ORDER BY next_recurrence_date ASC`,
    []
  );

  for (const template of result.rows) {
    const recurrenceType = template.recurrence_type;
    const catchupLimit = getRecurrenceCatchupLimit(recurrenceType);
    const existingInstanceMatchSql = getExistingInstanceMatchSql(recurrenceType);
    const targetOffsetMs = parsePgIntervalToMs(template.base_target_offset);
    const dueOffsetMs = parsePgIntervalToMs(template.base_due_offset);
    const now = new Date();
    const initialStatus = 'pending';
    const normalizedCycleFrequency = normalizeCycleRecurrenceFrequency(
      template.recurrence_type,
      template.specific_weekday
    );
    let accountingYearStart: string | null = null;
    if (normalizedCycleFrequency === 'yearly' && template.organization_id) {
      accountingYearStart =
        (await loadOrganizationAccountingYearStart({ query }, template.organization_id)) ||
        '2000-04-01';
    }

    const anchorTaskIdEarly = template.task_id ? String(template.task_id) : null;
    const mergedMetadata = await loadMergedRecurrenceInstanceMetadata(template);
    const copiedMetadata = buildCopiedInstanceMetadata(mergedMetadata, taskColumnSet);
    if (Object.keys(mergedMetadata).length > 0) {
      await syncRecurringTemplateMetadataFromTask({ query }, template.id, mergedMetadata);
    }
    if (Object.keys(copiedMetadata).length > 0) {
      await backfillTemplateInstancesMissingMetadata(
        template.id,
        anchorTaskIdEarly,
        copiedMetadata,
        taskColumnSet
      );
    }
    const assignees = await loadTemplateAssignees(template.id, template.task_id);
    const assigneeUserIds = assignees.map((a) => a.userId);
    const creatorId =
      assignees.find((a) => a.role === 'creator')?.userId || template.creator_id;

    const normalizedFrequency = normalizeTemplateFrequency(
      template.recurrence_type,
      template.specific_weekday
    );
    const endPolicy = parseRecurrenceEndPolicy(template);
    const anchorTaskId = template.task_id ? String(template.task_id) : null;
    let recurrenceTimeSource = resolveRecurrenceTimeSource(template);
    if (anchorTaskId) {
      const anchorRow = await loadSourceTask(anchorTaskId);
      if (anchorRow?.start_date) {
        recurrenceTimeSource = new Date(anchorRow.start_date);
      }
    }

    const repairedCursor = await repairDailyRecurrenceCursorIfSkewed(template);
    let cycleCursor = repairedCursor
      ? new Date(repairedCursor)
      : new Date(template.next_recurrence_date);
    let catchupGuard = 0;
    let lastCreatedTask: any = null;
    let templateCompleted = false;

    while (
      shouldContinueRecurrenceCatchup(
        cycleCursor,
        now,
        catchupGuard,
        catchupLimit,
        template.recurrence_type
      )
    ) {
      catchupGuard += 1;
      const recurrenceDate = new Date(cycleCursor);
      const startDate = resolveInstanceStartDate(
        recurrenceType,
        recurrenceDate,
        recurrenceTimeSource,
        now
      );

      const existingInstanceCount = await countTemplateInstances(template.id, anchorTaskId);
      if (!shouldGenerateRecurrenceCycle(endPolicy, startDate, existingInstanceCount)) {
        await completeRecurrenceTemplate(template.id);
        templateCompleted = true;
        break;
      }
      const targetDate = targetOffsetMs > 0 ? new Date(startDate.getTime() + targetOffsetMs) : null;
      const dueDate = new Date(startDate.getTime() + dueOffsetMs);
      const assigneeStatus = resolveInitialAssigneeStatus({ startDate });

      const existingInstanceParams: unknown[] = [template.id, startDate];
      let existingInstanceSql = `SELECT id
         FROM tasks
         WHERE (recurrence_template_id = $1`;
      if (anchorTaskId) {
        existingInstanceSql += ` OR id = $3`;
        existingInstanceParams.push(anchorTaskId);
      }
      existingInstanceSql += `) AND ${existingInstanceMatchSql} LIMIT 1`;
      const existingInstanceResult = await query(existingInstanceSql, existingInstanceParams);

      const lastCountResult = await query(
        `SELECT COALESCE(MAX(recurrence_instance_no), 0) AS max_no
         FROM tasks
         WHERE recurrence_template_id = $1`,
        [template.id]
      );
      const nextInstanceNo = Number(lastCountResult.rows[0]?.max_no || 0) + 1;

      let newTask: any = null;
      let conversationId: string | null = null;

      if (existingInstanceResult.rows.length > 0 && Object.keys(copiedMetadata).length > 0) {
        await backfillInstanceRecurrenceMetadata(
          existingInstanceResult.rows[0].id,
          copiedMetadata,
          taskColumnSet
        );
      }

      if (existingInstanceResult.rows.length === 0) {
      const instanceTitle = formatRecurringTitle(template.title, startDate, template.recurrence_type);
      const coreFields: Record<string, unknown> = {
        title: instanceTitle,
        description: template.description,
        task_type: 'recurring_instance',
        creator_id: creatorId,
        created_by: creatorId,
        organization_id: template.organization_id,
        start_date: startDate,
        target_date: targetDate,
        due_date: dueDate,
        frequency: normalizedFrequency,
        specific_weekday: template.specific_weekday,
        recurrence_type: template.recurrence_type,
        recurrence_interval: template.recurrence_interval || 1,
        category:
          (copiedMetadata.category as string) || template.category || 'general',
        status: initialStatus,
        recurrence_template_id: template.id,
        parent_task_id: template.id,
        recurrence_instance_no: nextInstanceNo,
        reporting_member_id: template.reporting_member_id || null,
      };

      const insertColumns = Object.keys(coreFields).filter((col) => taskColumnSet.has(col));
      const insertValues = insertColumns.map((col) => coreFields[col]);

      for (const [field, value] of Object.entries(copiedMetadata)) {
        if (!insertColumns.includes(field)) {
          insertColumns.push(field);
          insertValues.push(value);
        }
      }

      const placeholders = insertValues.map((_, index) => `$${index + 1}`).join(', ');
      const newTaskResult = await query(
        `INSERT INTO tasks (${insertColumns.join(', ')})
         VALUES (${placeholders})
         RETURNING *`,
        insertValues
      );

      newTask = newTaskResult.rows[0];

      for (const a of assignees) {
        await query(
          `INSERT INTO task_assignees (task_id, user_id, status, role, completed_at, verified_at, accepted_at)
           VALUES ($1, $2, $3, $4, NULL, NULL, NOW())
           ON CONFLICT (task_id, user_id) DO UPDATE
           SET status = EXCLUDED.status,
               completed_at = NULL,
               verified_at = NULL,
               accepted_at = COALESCE(task_assignees.accepted_at, EXCLUDED.accepted_at),
               role = EXCLUDED.role`,
          [newTask.id, a.userId, assigneeStatus, a.role]
        );
      }

      const convTypeCheck = await query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_name = 'conversations' AND column_name = 'type'`,
        []
      );
      const hasConversationType = convTypeCheck.rows.length > 0;
      const conversationResult = hasConversationType
        ? await query(
            `INSERT INTO conversations (id, type, name, is_group, is_task_group, task_id, created_by)
             VALUES (gen_random_uuid(), 'group', $1, TRUE, TRUE, $2, $3)
             RETURNING id`,
            [`Task: ${newTask.title}`, newTask.id, creatorId]
          )
        : await query(
            `INSERT INTO conversations (name, is_group, is_task_group, task_id, created_by)
             VALUES ($1, TRUE, TRUE, $2, $3)
             RETURNING id`,
            [`Task: ${newTask.title}`, newTask.id, creatorId]
          );

      conversationId = conversationResult.rows[0]?.id || null;

      if (conversationId) {
        await query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           VALUES ($1, $2, 'admin')
           ON CONFLICT (conversation_id, user_id) DO NOTHING`,
          [conversationId, creatorId]
        );
        for (const assigneeId of assigneeUserIds) {
          if (String(assigneeId) === String(creatorId)) continue;
          await query(
            `INSERT INTO conversation_members (conversation_id, user_id, role)
             VALUES ($1, $2, 'member')
             ON CONFLICT (conversation_id, user_id) DO NOTHING`,
            [conversationId, assigneeId]
          );
        }

        const creatorResult = await query(`SELECT name FROM users WHERE id = $1`, [creatorId]);
        const creatorName = creatorResult.rows[0]?.name || 'Admin';
        const welcomeMessage = `Task created by ${creatorName}`;

        const messageColumnCheck = await query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'messages' AND column_name = 'sender_organization_id'`,
          []
        );
        const hasSenderOrgId = messageColumnCheck.rows.some(
          (r: any) => r.column_name === 'sender_organization_id'
        );
        const messageColumns = ['conversation_id', 'sender_id', 'content', 'message_type'];
        const messageValues: any[] = [conversationId, creatorId, welcomeMessage, 'text'];
        if (hasSenderOrgId && template.organization_id) {
          messageColumns.push('sender_organization_id');
          messageValues.push(template.organization_id);
        }
        const messagePlaceholders = messageValues.map((_, index) => `$${index + 1}`).join(', ');
        const messageResult = await query(
          `INSERT INTO messages (${messageColumns.join(', ')})
           VALUES (${messagePlaceholders})
           RETURNING id`,
          messageValues
        );
        const messageId = messageResult.rows[0]?.id;
        if (messageId) {
          await insertMessageStatus(messageId, creatorId);
        }

        const realtimeRecipients = Array.from(
          new Set(assigneeUserIds.filter(Boolean).map((id) => String(id)))
        );
        await notifyRecurrenceCreated(io, {
          taskId: newTask.id,
          taskTitle: newTask.title,
          conversationId,
          creatorId,
          creatorName,
          assigneeUserIds: realtimeRecipients,
          welcomeMessage,
        });
        await emitRecurrenceRealtimeEvents(io, realtimeRecipients, {
          taskId: newTask.id,
          conversationId,
          title: newTask.title,
          assigneeStatus,
        });
      }
      }

      if (newTask?.id) {
        lastCreatedTask = newTask;
      }

      // Daily eve-before cursors map to instance start on the next UTC day; advancing from
      // startDate double-steps and skips days. Always advance from the cycle cursor.
      const cursorAdvanceBase =
        normalizedCycleFrequency === 'daily' ? recurrenceDate : startDate;
      cycleCursor = advanceRecurrenceCycleCursor(
        template.recurrence_type,
        template.recurrence_interval,
        template.specific_weekday,
        cursorAdvanceBase,
        accountingYearStart
      );
      if (normalizedCycleFrequency === 'daily') {
        cycleCursor = applyRecurrenceTimeOfDay(cycleCursor, recurrenceTimeSource);
      }

      const countAfterCycle = await countTemplateInstances(template.id, anchorTaskId);
      if (!shouldGenerateRecurrenceCycle(endPolicy, cycleCursor, countAfterCycle)) {
        await completeRecurrenceTemplate(template.id);
        templateCompleted = true;
        break;
      }
    }

    if (!templateCompleted) {
      await query(
        `UPDATE task_recurrence_templates
         SET last_generated_at = NOW(),
             next_recurrence_date = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [cycleCursor, template.id]
      );
    }

    if (creatorId && lastCreatedTask?.id) {
      await logTaskActivity(null, {
        taskId: lastCreatedTask.id,
        userId: creatorId,
        activityType: 'recurrence_started',
        message: 'New recurrence cycle created',
      });
    }
  }
};
