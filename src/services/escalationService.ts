import { query } from '../config/database';
import { createMessageByConversationId } from './messageService';
import { dispatchNotification } from './notification-bus.service';
import {
  parseEscalationRules,
  resolveTaskEscalationConfig,
} from './taskEscalationHelpers';

type TaskEscalationCandidate = {
  id: string;
  title: string;
  creator_id: string;
  organization_id: string;
  target_date: Date | string | null;
  due_date: Date | string | null;
  escalation_trigger: string | null;
  escalation_days_before: number | null;
  escalation_rules: unknown;
};

async function tasksTableHasColumn(columnName: string): Promise<boolean> {
  const result = await query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'tasks'
       AND column_name = $1
     LIMIT 1`,
    [columnName]
  );
  return result.rows.length > 0;
}

/**
 * Escalate tasks where auto_escalate is enabled and the per-task schedule is due.
 * Schedule: CURRENT_DATE >= (anchor_date - escalation_days_before days)
 * Anchor: target_date or due_date per escalation_trigger / escalation_rules.
 */
export const processTaskFieldEscalations = async (): Promise<void> => {
  const hasAutoEscalate = await tasksTableHasColumn('auto_escalate');
  if (!hasAutoEscalate) return;

  const hasTriggerCol = await tasksTableHasColumn('escalation_trigger');
  const hasDaysCol = await tasksTableHasColumn('escalation_days_before');

  const triggerExpr = hasTriggerCol
    ? `COALESCE(NULLIF(TRIM(t.escalation_trigger), ''), NULLIF(TRIM(t.escalation_rules->>'trigger'), ''), 'due_date')`
    : `COALESCE(NULLIF(TRIM(t.escalation_rules->>'trigger'), ''), 'due_date')`;

  const daysExpr = hasDaysCol
    ? `COALESCE(t.escalation_days_before, NULLIF(TRIM(t.escalation_rules->>'days_before'), '')::int, 0)`
    : `COALESCE(NULLIF(TRIM(t.escalation_rules->>'days_before'), '')::int, 0)`;

  const whenExpr = `COALESCE(NULLIF(LOWER(TRIM(t.escalation_rules->>'when')), ''), 'before')`;
  const offsetExpr = `COALESCE(
    NULLIF(TRIM(t.escalation_rules->>'offset_days'), '')::int,
    CASE WHEN ${whenExpr} = 'on' THEN 0 ELSE ${daysExpr} END,
    0
  )`;

  const scheduleDueExpr = `(
    ${whenExpr} = 'after'
    AND CURRENT_DATE >= (t.due_date::date + (${offsetExpr} * INTERVAL '1 day'))
  ) OR (
    ${whenExpr} = 'on'
    AND CURRENT_DATE >= t.due_date::date
  ) OR (
    ${whenExpr} NOT IN ('after', 'on')
    AND CURRENT_DATE >= (t.due_date::date - (${offsetExpr} * INTERVAL '1 day'))
  )`;

  const scheduleTargetExpr = `(
    ${whenExpr} = 'after'
    AND CURRENT_DATE >= (t.target_date::date + (${offsetExpr} * INTERVAL '1 day'))
  ) OR (
    ${whenExpr} = 'on'
    AND CURRENT_DATE >= t.target_date::date
  ) OR (
    ${whenExpr} NOT IN ('after', 'on')
    AND CURRENT_DATE >= (t.target_date::date - (${offsetExpr} * INTERVAL '1 day'))
  )`;

  const result = await query(
    `SELECT
       t.id,
       t.title,
       COALESCE(t.created_by, t.creator_id) AS creator_id,
       t.organization_id,
       t.target_date,
       t.due_date,
       ${hasTriggerCol ? 't.escalation_trigger,' : ''}
       ${hasDaysCol ? 't.escalation_days_before,' : ''}
       t.escalation_rules
     FROM tasks t
     WHERE COALESCE(t.auto_escalate, false) = true
       AND COALESCE(t.escalation_status, 'none') = 'none'
       AND COALESCE(t.status, '') NOT IN ('completed', 'deleted', 'rejected', 'cancelled')
       AND COALESCE(t.is_recurring_template, false) = false
       AND COALESCE(t.task_type, 'one_time') NOT IN ('recurring_template')
       AND (
         (
           ${triggerExpr} = 'target_date'
           AND t.target_date IS NOT NULL
           AND (${scheduleTargetExpr})
         )
         OR (
           ${triggerExpr} <> 'target_date'
           AND t.due_date IS NOT NULL
           AND (${scheduleDueExpr})
         )
       )
       AND EXISTS (
         SELECT 1
         FROM task_assignees ta
         WHERE ta.task_id = t.id
           AND COALESCE(ta.role, 'member') <> 'escalation_contact'
           AND ta.verified_at IS NULL
           AND (
             ta.completed_at IS NULL
             OR COALESCE(ta.status, '') NOT IN ('completed', 'done')
           )
       )`,
    []
  );

  for (const row of result.rows as TaskEscalationCandidate[]) {
    const { trigger, when, offsetDays } = resolveTaskEscalationConfig(row);
    const anchor =
      trigger === 'target_date' ? row.target_date : row.due_date;
    const anchorLabel = trigger === 'target_date' ? 'Target Date' : 'Due Date';
    const anchorDay =
      anchor instanceof Date
        ? anchor.toISOString().slice(0, 10)
        : anchor
          ? String(anchor).slice(0, 10)
          : '';

    const whenLabel = when === 'on' ? 'on' : when === 'after' ? 'After' : 'Before';
    const dayPart =
      when === 'on'
        ? 'on'
        : `${offsetDays} day${offsetDays === 1 ? '' : 's'}`;
    const reason = `Auto escalation: ${whenLabel} ${dayPart} of ${anchorLabel}${anchorDay ? ` (${anchorDay})` : ''}`;

    await escalateTask(row.id, reason);
  }
};

/** @deprecated Use processTaskFieldEscalations — kept for imports/tests */
export const escalateUnacceptedTasks = async (): Promise<void> => {
  await processTaskFieldEscalations();
};

/** @deprecated Use processTaskFieldEscalations */
export const escalateOverdueTasks = async (): Promise<void> => {
  // No-op: per-task fields drive escalation
};

async function getEscalationRecipientIds(taskId: string): Promise<string[]> {
  const ids = new Set<string>();

  const assigneeResult = await query(
    `SELECT user_id
     FROM task_assignees
     WHERE task_id = $1
       AND COALESCE(role, 'member') = 'escalation_contact'`,
    [taskId]
  );
  for (const row of assigneeResult.rows) {
    if (row.user_id) ids.add(String(row.user_id));
  }

  const rulesResult = await query(
    `SELECT escalation_rules FROM tasks WHERE id = $1 LIMIT 1`,
    [taskId]
  );
  const rules = parseEscalationRules(rulesResult.rows[0]?.escalation_rules);
  if (Array.isArray(rules.contact_ids)) {
    for (const id of rules.contact_ids) {
      if (id) ids.add(String(id));
    }
  }

  if (ids.size === 0) {
    const fallback = await query(
      `SELECT user_id
       FROM task_assignees
       WHERE task_id = $1
         AND COALESCE(role, 'member') <> 'escalation_contact'`,
      [taskId]
    );
    for (const row of fallback.rows) {
      if (row.user_id) ids.add(String(row.user_id));
    }
  }

  return Array.from(ids);
}

/**
 * Mark task escalated, post to task group chat, notify escalation contacts (or assignees).
 */
export const escalateTask = async (
  taskId: string,
  reason: string
): Promise<void> => {
  const updated = await query(
    `UPDATE tasks
     SET escalation_status = 'escalated', updated_at = NOW()
     WHERE id = $1
       AND COALESCE(escalation_status, 'none') = 'none'
     RETURNING id, title, COALESCE(created_by, creator_id) AS creator_id, organization_id`,
    [taskId]
  );

  if (updated.rows.length === 0) return;

  const task = updated.rows[0];
  const conversationResult = await query(
    `SELECT id FROM conversations
     WHERE task_id = $1 AND is_task_group = TRUE
     LIMIT 1`,
    [taskId]
  );

  if (conversationResult.rows.length > 0) {
    const conversationId = conversationResult.rows[0].id;
    await createMessageByConversationId(
      conversationId,
      task.creator_id,
      'text',
      `⚠️ Task Escalation: ${task.title}\nReason: ${reason}`,
      task.organization_id,
      'shared_to_group'
    );
  }

  const recipientIds = await getEscalationRecipientIds(taskId);
  if (recipientIds.length === 0) return;

  await dispatchNotification({
    type: 'TASK_ESCALATED',
    recipientIds,
    title: 'Task Escalated',
    body: reason,
    refType: 'task',
    refId: taskId,
  });
};

/** Recurring template misses are not per-task field driven — left as no-op */
export const escalateMissedRecurrence = async (): Promise<void> => {
  // Intentionally disabled; use per-task auto_escalate on generated instances instead.
};
