/**
 * Link anchor tasks to templates and repair daily templates stuck with a far-future cursor.
 * Usage: node scripts/backfill-recurring-anchors.js
 */
require('dotenv').config();
const { Pool } = require('pg');
const { generateNextRecurrence } = require('../dist/services/recurringTaskService');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const linked = await pool.query(
    `UPDATE tasks t
     SET recurrence_template_id = trt.id,
         parent_task_id = COALESCE(t.parent_task_id, trt.id),
         recurrence_instance_no = COALESCE(t.recurrence_instance_no, 1),
         updated_at = NOW()
     FROM task_recurrence_templates trt
     WHERE trt.task_id = t.id
       AND t.recurrence_template_id IS NULL
     RETURNING t.id, t.title`
  );
  console.log('Linked anchors:', linked.rowCount, linked.rows);

  const stuck = await pool.query(
    `SELECT id, title, next_recurrence_date
     FROM task_recurrence_templates
     WHERE status = 'active'
       AND recurrence_type = 'daily'
       AND next_recurrence_date IS NOT NULL
       AND next_recurrence_date > NOW() + INTERVAL '1 day'`
  );

  for (const row of stuck.rows) {
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
         WHERE (t.recurrence_template_id = $1 OR t.id = (
           SELECT task_id FROM task_recurrence_templates WHERE id = $1
         ))
         AND (t.start_date AT TIME ZONE 'UTC')::date = s.d
       )
       ORDER BY s.d LIMIT 1`,
      [row.id]
    );
    const d = missing.rows[0]?.d;
    if (!d) continue;
    const repair = new Date(d);
    repair.setUTCDate(repair.getUTCDate() - 1);
    repair.setUTCHours(22, 0, 0, 0);
    await pool.query(
      `UPDATE task_recurrence_templates
       SET next_recurrence_date = $1, updated_at = NOW()
       WHERE id = $2`,
      [repair.toISOString(), row.id]
    );
    console.log('Reset cursor', row.title, '->', repair.toISOString());
  }

  await pool.end();
  await generateNextRecurrence();
  console.log('Catch-up generation complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
