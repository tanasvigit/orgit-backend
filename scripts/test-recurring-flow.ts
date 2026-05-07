import pool, { query } from '../src/config/database';
import { generateNextRecurrence } from '../src/services/recurringTaskService';

const TEST_TAG = '[RECURRENCE_TEST]';

const fail = (message: string): never => {
  throw new Error(`${TEST_TAG} ${message}`);
};

async function ensurePrerequisites() {
  const tableChecks = await query(
    `SELECT
      to_regclass('public.task_recurrence_templates') AS templates,
      to_regclass('public.task_template_assignees') AS blueprints`,
    []
  );
  if (!tableChecks.rows[0]?.templates) fail('Missing task_recurrence_templates table.');
  if (!tableChecks.rows[0]?.blueprints) fail('Missing task_template_assignees table.');
}

async function hasBaseTargetOffsetColumn() {
  const result = await query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'task_recurrence_templates'
        AND column_name = 'base_target_offset'
    ) AS exists`,
    []
  );
  return Boolean(result.rows[0]?.exists);
}

async function getActorsForScenario() {
  const rows = await query(
    `SELECT uo.organization_id, uo.user_id
     FROM user_organizations uo
     ORDER BY uo.created_at ASC NULLS LAST`,
    []
  );
  const byOrg = new Map<string, string[]>();
  for (const row of rows.rows) {
    const orgId = String(row.organization_id || '');
    const userId = String(row.user_id || '');
    if (!orgId || !userId) continue;
    if (!byOrg.has(orgId)) byOrg.set(orgId, []);
    const list = byOrg.get(orgId)!;
    if (!list.includes(userId)) list.push(userId);
  }
  for (const [orgId, users] of byOrg.entries()) {
    if (users.length >= 3) {
      return { orgId, ownerId: users[0], reportingId: users[1], assigneeId: users[2] };
    }
  }
  // Fallback: use any 3 users globally and infer org from first available membership.
  const users = await query(
    `SELECT id FROM users ORDER BY created_at ASC NULLS LAST LIMIT 3`,
    []
  );
  if (users.rows.length < 3) {
    fail('Need at least 3 users in database for owner/reporting/assignee checks.');
  }
  const ownerId = String(users.rows[0].id);
  const reportingId = String(users.rows[1].id);
  const assigneeId = String(users.rows[2].id);
  const ownerOrg = await query(
    `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
    [ownerId]
  );
  const anyOrg = await query(
    `SELECT organization_id FROM user_organizations WHERE organization_id IS NOT NULL LIMIT 1`,
    []
  );
  const orgId = String(ownerOrg.rows[0]?.organization_id || anyOrg.rows[0]?.organization_id || '');
  if (!orgId) {
    fail('Could not determine organization_id for test template.');
  }
  return { orgId, ownerId, reportingId, assigneeId };
}

const monthShort = (d: Date) => d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toLowerCase();

async function run() {
  console.log(`${TEST_TAG} Starting recurring requirements test...`);
  await ensurePrerequisites();

  const { orgId, ownerId, reportingId, assigneeId } = await getActorsForScenario();
  const supportsBaseTargetOffset = await hasBaseTargetOffsetColumn();

  const now = new Date();
  const startDate = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // past -> todo
  const targetOffsetDays = 4;
  const dueOffsetDays = 7;
  const targetDate = new Date(startDate.getTime() + targetOffsetDays * 24 * 60 * 60 * 1000);
  const dueDate = new Date(startDate.getTime() + dueOffsetDays * 24 * 60 * 60 * 1000);
  const baseTitle = `${TEST_TAG} abcd`;

  const templateInsert = supportsBaseTargetOffset
    ? await query(
        `INSERT INTO task_recurrence_templates (
          organization_id, title, description, category, creator_id, reporting_member_id,
          recurrence_type, recurrence_interval, base_start_date, base_target_offset, base_due_offset,
          next_recurrence_date, status
        ) VALUES (
          $1, $2, $3, 'general', $4, $5,
          'monthly', 1, $6, $7::interval, $8::interval,
          $9, 'active'
        ) RETURNING id, title, next_recurrence_date`,
        [
          orgId,
          baseTitle,
          'Recurring task scenario',
          ownerId,
          reportingId,
          startDate.toISOString(),
          `${targetOffsetDays} days`,
          `${dueOffsetDays} days`,
          startDate.toISOString(),
        ]
      )
    : await query(
        `INSERT INTO task_recurrence_templates (
          organization_id, title, description, category, creator_id, reporting_member_id,
          recurrence_type, recurrence_interval, base_start_date, base_due_offset,
          next_recurrence_date, status
        ) VALUES (
          $1, $2, $3, 'general', $4, $5,
          'monthly', 1, $6, $7::interval,
          $8, 'active'
        ) RETURNING id, title, next_recurrence_date`,
        [
          orgId,
          baseTitle,
          'Recurring task scenario',
          ownerId,
          reportingId,
          startDate.toISOString(),
          `${dueOffsetDays} days`,
          startDate.toISOString(),
        ]
      );
  const templateId = templateInsert.rows[0].id as string;

  await query(
    `INSERT INTO task_template_assignees (template_id, user_id, role)
     VALUES ($1, $2, 'creator'), ($1, $3, 'reporting_member'), ($1, $4, 'member')
     ON CONFLICT (template_id, user_id) DO NOTHING`,
    [templateId, ownerId, reportingId, assigneeId]
  );

  const before = await query(
    `SELECT COUNT(*)::int AS count FROM tasks WHERE recurrence_template_id = $1`,
    [templateId]
  );

  await generateNextRecurrence();

  const generatedRows = await query(
    `SELECT id, title, status, start_date, target_date, due_date, recurrence_instance_no, reporting_member_id
     FROM tasks
     WHERE recurrence_template_id = $1
     ORDER BY recurrence_instance_no DESC
     LIMIT 1`,
    [templateId]
  );

  if (generatedRows.rows.length === 0) fail('No generated recurring instance found.');

  const task = generatedRows.rows[0];
  const after = await query(
    `SELECT COUNT(*)::int AS count FROM tasks WHERE recurrence_template_id = $1`,
    [templateId]
  );

  if (after.rows[0].count !== before.rows[0].count + 1) {
    fail(`Expected exactly one new instance. before=${before.rows[0].count}, after=${after.rows[0].count}`);
  }

  const expectedTitle = `${baseTitle} ${monthShort(new Date(task.start_date))}`;
  if (String(task.title).trim().toLowerCase() !== expectedTitle.toLowerCase()) {
    fail(`Title mismatch. expected="${expectedTitle}" actual="${task.title}"`);
  }

  if (String(task.status) !== 'pending') {
    fail(`Task status mismatch. expected=pending actual=${task.status}`);
  }

  if (String(task.reporting_member_id) !== reportingId) {
    fail('Generated task reporting_member_id mismatch.');
  }

  const startMs = new Date(task.start_date).getTime();
  const targetMs = task.target_date ? new Date(task.target_date).getTime() : NaN;
  const dueMs = new Date(task.due_date).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const targetDiffDays = Math.round((targetMs - startMs) / dayMs);
  const dueDiffDays = Math.round((dueMs - startMs) / dayMs);

  if (supportsBaseTargetOffset && targetDiffDays !== targetOffsetDays) {
    fail(`Target offset mismatch. expected=${targetOffsetDays}d actual=${targetDiffDays}d`);
  }
  if (dueDiffDays !== dueOffsetDays) {
    fail(`Due offset mismatch. expected=${dueOffsetDays}d actual=${dueDiffDays}d`);
  }

  const assignees = await query(
    `SELECT user_id, role, status
     FROM task_assignees
     WHERE task_id = $1
     ORDER BY role ASC`,
    [task.id]
  );

  const roleMap = new Map(assignees.rows.map((r: any) => [String(r.user_id), { role: r.role, status: r.status }]));

  if (roleMap.get(ownerId)?.role !== 'creator') fail('Owner did not remain creator in generated task.');
  if (roleMap.get(reportingId)?.role !== 'reporting_member') fail('Reporting member role mismatch in generated task.');
  if (roleMap.get(assigneeId)?.role !== 'member') fail('Assignee role mismatch in generated task.');

  const expectedAssigneeStatus = new Date(task.start_date).getTime() > Date.now() ? 'scheduled' : 'todo';
  for (const [uid, info] of roleMap.entries()) {
    if (info.status !== expectedAssigneeStatus) {
      fail(`Assignee status mismatch for ${uid}. expected=${expectedAssigneeStatus} actual=${info.status}`);
    }
  }

  console.log(`${TEST_TAG} PASS`);
  console.log(`${TEST_TAG} Template=${templateId}`);
  console.log(`${TEST_TAG} Generated task=${task.id} title="${task.title}" status=${task.status}`);
  console.log(`${TEST_TAG} Dates: start=${task.start_date} target=${task.target_date} due=${task.due_date}`);
  console.log(`${TEST_TAG} Assignees OK (creator/reporting/member, status=${expectedAssigneeStatus})`);
}

run()
  .catch((error: any) => {
    console.error(`${TEST_TAG} FAIL`, error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
