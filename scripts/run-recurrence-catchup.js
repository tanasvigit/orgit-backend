/**
 * Reset template cursor (optional) and run generateNextRecurrence once.
 * node scripts/run-recurrence-catchup.js [templateId]
 */
require('dotenv').config();
const { Pool } = require('pg');

const TEMPLATE_ID =
  process.argv[2] || '59a50d4a-2d12-4965-9f50-e8cba3957685';

async function resetCursor(pool) {
  const missing = await pool.query(
    `WITH series AS (
       SELECT generate_series(
         (SELECT (base_start_date AT TIME ZONE 'UTC')::date + 1
          FROM task_recurrence_templates WHERE id = $1),
         CURRENT_DATE,
         '1 day'::interval
       )::date AS d
     )
     SELECT s.d FROM series s
     WHERE NOT EXISTS (
       SELECT 1 FROM tasks t
       WHERE t.recurrence_template_id = $1
         AND (t.start_date AT TIME ZONE 'UTC')::date = s.d
     )
     ORDER BY s.d LIMIT 1`,
    [TEMPLATE_ID]
  );
  const firstMissing = missing.rows[0]?.d;
  if (!firstMissing) return null;
  const repairCursor = new Date(firstMissing);
  repairCursor.setUTCDate(repairCursor.getUTCDate() - 1);
  repairCursor.setUTCHours(22, 0, 0, 0);
  await pool.query(
    `UPDATE task_recurrence_templates
     SET next_recurrence_date = $1, updated_at = NOW()
     WHERE id = $2`,
    [repairCursor.toISOString(), TEMPLATE_ID]
  );
  return repairCursor;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const before = await pool.query(
    `SELECT next_recurrence_date, next_recurrence_date <= NOW() AS eligible
     FROM task_recurrence_templates WHERE id = $1`,
    [TEMPLATE_ID]
  );
  console.log('Before:', before.rows[0]);

  const cursor = await resetCursor(pool);
  console.log('Reset cursor to:', cursor?.toISOString());

  await pool.end();

  const { generateNextRecurrence } = require('../dist/services/recurringTaskService');
  await generateNextRecurrence();

  const pool2 = new Pool({ connectionString: process.env.DATABASE_URL });
  const after = await pool2.query(
    `SELECT next_recurrence_date, last_generated_at FROM task_recurrence_templates WHERE id = $1`,
    [TEMPLATE_ID]
  );
  const tasks = await pool2.query(
    `SELECT title, start_date, recurrence_instance_no
     FROM tasks WHERE recurrence_template_id = $1
     ORDER BY start_date`,
    [TEMPLATE_ID]
  );
  console.log('After template:', after.rows[0]);
  console.log('Instances:', tasks.rows);
  await pool2.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
