/**
 * Reset daily template cursor to first missing cycle and run catch-up generation.
 * Usage: node scripts/repair-daily-template-cursor.js [--dry-run]
 */
require('dotenv').config();
const { Pool } = require('pg');

const TEMPLATE_ID = '59a50d4a-2d12-4965-9f50-e8cba3957685';
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const tmpl = await pool.query(
    `SELECT id, title, next_recurrence_date, recurrence_type, task_id
     FROM task_recurrence_templates WHERE id = $1`,
    [TEMPLATE_ID]
  );
  if (!tmpl.rows[0]) {
    console.error('Template not found');
    process.exit(1);
  }

  // First missing linked instance day after anchor (use PG date in UTC for consistency)
  const missing = await pool.query(
    `WITH series AS (
       SELECT generate_series(
         (SELECT (base_start_date AT TIME ZONE 'UTC')::date + 1 FROM task_recurrence_templates WHERE id = $1),
         CURRENT_DATE,
         '1 day'::interval
       )::date AS d
     )
     SELECT s.d
     FROM series s
     WHERE NOT EXISTS (
       SELECT 1 FROM tasks t
       WHERE t.recurrence_template_id = $1
         AND (t.start_date AT TIME ZONE 'UTC')::date = s.d
     )
     ORDER BY s.d
     LIMIT 1`,
    [TEMPLATE_ID]
  );

  const firstMissing = missing.rows[0]?.d;
  if (!firstMissing) {
    console.log('No missing instance days found.');
    await pool.end();
    return;
  }

  // Match existing task date convention: (logical_date - 1 day) at 22:00 UTC
  const repairCursor = new Date(firstMissing);
  repairCursor.setUTCDate(repairCursor.getUTCDate() - 1);
  repairCursor.setUTCHours(22, 0, 0, 0);

  console.log('Template:', tmpl.rows[0].title);
  console.log('Current next_recurrence_date:', tmpl.rows[0].next_recurrence_date);
  console.log('First missing cycle (UTC date):', firstMissing);
  console.log('Repair cursor:', repairCursor.toISOString());

  if (dryRun) {
    console.log('Dry run — no DB updates.');
    await pool.end();
    return;
  }

  await pool.query(
    `UPDATE task_recurrence_templates
     SET next_recurrence_date = $1,
         updated_at = NOW()
     WHERE id = $2`,
    [repairCursor.toISOString(), TEMPLATE_ID]
  );

  console.log('Updated next_recurrence_date. Rebuild backend and restart server, or run:');
  console.log('  npx ts-node scripts/test-recurring-flow.ts  (if applicable)');
  console.log('Cron will catch up missed daily instances on next minute tick.');

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
