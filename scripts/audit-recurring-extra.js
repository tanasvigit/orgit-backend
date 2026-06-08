require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const yearly = await pool.query(`
    SELECT t.id, t.title, t.start_date, t.due_date, t.recurrence_template_id,
           rt.id AS tmpl_id, rt.status, rt.next_recurrence_date, rt.recurrence_type
    FROM tasks t
    LEFT JOIN task_recurrence_templates rt ON rt.task_id = t.id
    WHERE t.id IN ('1680c086-5d54-4001-b2ca-2532a7dfc443','e1a24989-c2b5-47e1-9b77-9e8a3e1997e9','110592e9-c8b8-4e7f-908e-7f73212b1241','52ea1d95-5d34-47c8-9593-1bbe1064a525','f5e532f8-9291-44b2-80f0-2f8a8841df71')
  `);
  console.log('=== YEARLY ROWS ===');
  console.log(JSON.stringify(yearly.rows, null, 2));

  const daily = await pool.query(`
    SELECT t.id, t.title, t.frequency, t.recurrence_type, t.recurrence_template_id,
           rt.id AS tmpl_id, rt.next_recurrence_date
    FROM tasks t
    LEFT JOIN task_recurrence_templates rt ON rt.id = t.recurrence_template_id OR rt.task_id = t.id
    WHERE t.id IN ('88307690-0960-4d04-bc8e-9a00306970b2','55066442-73c5-4887-8c3b-6a468ca8ff3d')
  `);
  console.log('=== DAILY ROWS ===');
  console.log(JSON.stringify(daily.rows, null, 2));

  await pool.end();
})();
