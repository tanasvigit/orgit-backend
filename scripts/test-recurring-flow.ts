import pool, { query } from '../src/config/database';
import { generateNextRecurrence } from '../src/services/recurringTaskService';

const TEST_TAG = '[RECURRENCE_TEST]';

const fail = (message: string): never => {
  throw new Error(`${TEST_TAG} ${message}`);
};

async function ensurePrerequisites() {
  const templateTable = await query(`SELECT to_regclass('public.task_recurrence_templates') AS name`);
  if (!templateTable.rows[0]?.name) {
    fail('Missing table task_recurrence_templates. Run migrations first.');
  }

  const assigneeBlueprintTable = await query(`SELECT to_regclass('public.task_template_assignees') AS name`);
  if (!assigneeBlueprintTable.rows[0]?.name) {
    fail('Missing table task_template_assignees. Run migrations first.');
  }
}

async function getSeedActors() {
  // Primary path for this codebase: user_organizations maps users to orgs.
  const membershipResult = await query(
    `SELECT uo.organization_id AS org_id, uo.user_id
     FROM user_organizations uo
     INNER JOIN users u ON u.id = uo.user_id
     ORDER BY uo.created_at ASC NULLS LAST
     LIMIT 1`
  );
  if (membershipResult.rows[0]?.org_id && membershipResult.rows[0]?.user_id) {
    return {
      orgId: membershipResult.rows[0].org_id as string,
      userId: membershipResult.rows[0].user_id as string,
    };
  }

  // Fallback for older schemas with users.organization_id.
  const hasUsersOrganizationColumn = await query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'users'
        AND column_name = 'organization_id'
    ) AS has_column`
  );
  if (hasUsersOrganizationColumn.rows[0]?.has_column) {
    const row = await query(
      `SELECT id AS user_id, organization_id AS org_id
       FROM users
       WHERE organization_id IS NOT NULL
       ORDER BY created_at ASC
       LIMIT 1`
    );
    if (row.rows[0]?.org_id && row.rows[0]?.user_id) {
      return {
        orgId: row.rows[0].org_id as string,
        userId: row.rows[0].user_id as string,
      };
    }
  }

  fail('No usable user-organization mapping found (user_organizations/users.organization_id).');
}

async function run() {
  console.log(`${TEST_TAG} Starting recurring flow verification...`);
  await ensurePrerequisites();
  const { orgId, userId } = await getSeedActors();

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

  // Create template controller with recurrence due now (so generator should create one new cycle).
  const templateResult = await query(
    `INSERT INTO task_recurrence_templates (
      organization_id, title, description, category, creator_id,
      recurrence_type, recurrence_interval, base_start_date, base_due_offset,
      next_recurrence_date, status
    )
    VALUES ($1, $2, $3, 'general', $4, 'monthly', 1, $5, '5 days'::interval, $6, 'active')
    RETURNING *`,
    [
      orgId,
      `${TEST_TAG} MobileWebRecurring`,
      'Recurring task with web/mobile-like fields',
      userId,
      fiveDaysAgo.toISOString(),
      yesterday.toISOString(),
    ]
  );
  const template = templateResult.rows[0];

  // Seed assignee blueprint (copied into each generated instance).
  await query(
    `INSERT INTO task_template_assignees (template_id, user_id, role)
     VALUES ($1, $2, 'creator')
     ON CONFLICT (template_id, user_id) DO NOTHING`,
    [template.id, userId]
  );

  // Seed old completed instance (must remain completed).
  const completedInstance = await query(
    `INSERT INTO tasks (
      title, description, task_type, creator_id, created_by, organization_id,
      start_date, due_date, recurrence_type, recurrence_interval, category, status,
      recurrence_template_id, parent_task_id, recurrence_instance_no, auto_escalate
    )
    VALUES (
      $1, $2, 'recurring_instance', $3, $3, $4,
      $5, $6, 'monthly', 1, 'general', 'completed',
      $7, $7, 1, false
    )
    RETURNING id, status`,
    [
      `${TEST_TAG} PrevCompleted`,
      'previous cycle completed',
      userId,
      orgId,
      fiveDaysAgo.toISOString(),
      twoDaysAgo.toISOString(),
      template.id,
    ]
  );

  // Seed old overdue-ish instance (status kept in_progress with past due; must remain unchanged).
  const overdueInstance = await query(
    `INSERT INTO tasks (
      title, description, task_type, creator_id, created_by, organization_id,
      start_date, due_date, recurrence_type, recurrence_interval, category, status,
      recurrence_template_id, parent_task_id, recurrence_instance_no, auto_escalate
    )
    VALUES (
      $1, $2, 'recurring_instance', $3, $3, $4,
      $5, $6, 'monthly', 1, 'general', 'in_progress',
      $7, $7, 2, false
    )
    RETURNING id, status`,
    [
      `${TEST_TAG} PrevOverdue`,
      'previous cycle overdue candidate',
      userId,
      orgId,
      twoDaysAgo.toISOString(),
      yesterday.toISOString(),
      template.id,
    ]
  );

  const beforeCount = await query(
    `SELECT COUNT(*)::int AS count FROM tasks WHERE recurrence_template_id = $1`,
    [template.id]
  );

  await generateNextRecurrence();

  const afterRows = await query(
    `SELECT id, title, status, recurrence_instance_no, start_date, due_date
     FROM tasks
     WHERE recurrence_template_id = $1
     ORDER BY recurrence_instance_no ASC`,
    [template.id]
  );

  const afterCount = afterRows.rows.length;
  const expected = Number(beforeCount.rows[0].count) + 1;
  if (afterCount !== expected) {
    fail(`Expected ${expected} instances, found ${afterCount}.`);
  }

  const newest = afterRows.rows[afterRows.rows.length - 1];
  if (!String(newest.title).includes(' - ')) {
    fail('Newest instance title is not month-formatted.');
  }

  const completedCheck = await query(`SELECT status FROM tasks WHERE id = $1`, [completedInstance.rows[0].id]);
  if (completedCheck.rows[0]?.status !== 'completed') {
    fail('Previous completed task was modified unexpectedly.');
  }

  const overdueCheck = await query(`SELECT status, due_date FROM tasks WHERE id = $1`, [overdueInstance.rows[0].id]);
  if (overdueCheck.rows[0]?.status !== 'in_progress') {
    fail('Previous overdue/in-progress task status was modified unexpectedly.');
  }
  if (new Date(overdueCheck.rows[0].due_date).getTime() >= now.getTime()) {
    fail('Previous overdue task due_date was moved forward unexpectedly.');
  }

  console.log(`${TEST_TAG} PASS`);
  console.log(`${TEST_TAG} Template: ${template.id}`);
  console.log(`${TEST_TAG} New instance: ${newest.id} | ${newest.title} | status=${newest.status}`);
  console.log(
    `${TEST_TAG} Preserved old statuses: completed=${completedCheck.rows[0].status}, overdueCandidate=${overdueCheck.rows[0].status}`
  );
}

run()
  .catch((error: any) => {
    console.error(`${TEST_TAG} FAIL`, error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

