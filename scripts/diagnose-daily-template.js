require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const TEMPLATE_ID = '59a50d4a-2d12-4965-9f50-e8cba3957685';

async function main() {
  const now = await pool.query(`SELECT NOW() AS db_now, CURRENT_DATE AS today`);
  console.log('DB now:', now.rows[0]);

  const tmpl = await pool.query(
    `SELECT * FROM task_recurrence_templates WHERE id = $1`,
    [TEMPLATE_ID]
  );
  console.log('\n=== TEMPLATE ===');
  console.log(JSON.stringify(tmpl.rows[0], null, 2));

  const eligible = await pool.query(
    `SELECT id, title, next_recurrence_date,
            next_recurrence_date <= NOW() AS would_run_now
     FROM task_recurrence_templates
     WHERE id = $1`,
    [TEMPLATE_ID]
  );
  console.log('\n=== JOB ELIGIBILITY (next <= NOW()) ===');
  console.log(eligible.rows[0]);

  const instances = await pool.query(
    `SELECT id, title, start_date, due_date, recurrence_instance_no,
            recurrence_template_id, frequency, recurrence_type, created_at
     FROM tasks
     WHERE recurrence_template_id = $1
        OR id = $2
     ORDER BY start_date NULLS LAST, created_at`,
    [TEMPLATE_ID, tmpl.rows[0]?.task_id]
  );
  console.log('\n=== INSTANCES + ANCHOR ===');
  for (const r of instances.rows) {
    console.log({
      title: r.title,
      id: r.id.slice(0, 8),
      start: r.start_date,
      due: r.due_date,
      inst: r.recurrence_instance_no,
      freq: r.frequency,
      recur: r.recurrence_type,
      created: r.created_at,
    });
  }

  const gaps = await pool.query(
    `WITH days AS (
       SELECT generate_series(
         (SELECT base_start_date::date FROM task_recurrence_templates WHERE id = $1),
         CURRENT_DATE,
         '1 day'::interval
       )::date AS d
     )
     SELECT d.d,
            EXISTS (
              SELECT 1 FROM tasks t
              WHERE t.recurrence_template_id = $1
                AND t.start_date::date = d.d::date
            ) AS has_linked_instance,
            EXISTS (
              SELECT 1 FROM tasks t
              WHERE t.id = $2 AND t.start_date::date = d.d
            ) AS anchor_on_day
     FROM days d
     ORDER BY d.d`,
    [TEMPLATE_ID, tmpl.rows[0]?.task_id]
  );
  console.log('\n=== DAY COVERAGE (anchor start → today) ===');
  for (const r of gaps.rows) {
    const mark =
      r.has_linked_instance || r.anchor_on_day ? '✓' : 'MISSING';
    console.log(`${r.d.toISOString().slice(0, 10)} ${mark}`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
