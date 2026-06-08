require('dotenv').config();
const { Pool } = require('pg');

const ids = [
  '074dd837-e860-4c4f-8822-74a93dd00e3a',
  '082e0a02-c093-447e-a3bb-9ee7c92808ab',
  '110592e9-c8b8-4e7f-908e-7f73212b1241',
  '1680c086-5d54-4001-b2ca-2532a7dfc443',
  '45b704a9-5851-47e6-a979-47d2aa5fb6ee',
  '52ea1d95-5d34-47c8-9593-1bbe1064a525',
  '55066442-73c5-4887-8c3b-6a468ca8ff3d',
  '6a42aca5-fe6e-484d-8905-594477712c31',
  '6af80de5-c5bb-46d3-a628-ae8cadcb58c4',
  '7685c8be-2b98-4b87-9120-688d46d6c321',
  '88307690-0960-4d04-bc8e-9a00306970b2',
  'a1c95082-4653-41f4-8af0-fe8b5195f286',
  'a4563814-6a78-4f20-a730-d8f2110fadbb',
  'a7a80442-0bc8-4d96-946f-8ecab8e16620',
  'ac46df9e-0d16-4fdb-ad72-21d66ae198df',
  'dd60ccc9-24a7-4c55-8bae-ea935791cb76',
  'e0967c66-73d6-477f-ae72-9e50388b6a9c',
  'e1607ec7-ebb2-4104-8890-9a85560a3a76',
  'e1a24989-c2b5-47e1-9b77-9e8a3e1997e9',
  'f5e532f8-9291-44b2-80f0-2f8a8841df71',
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const tasks = await pool.query(
    `SELECT t.id, t.title, t.task_type, t.frequency, t.recurrence_type,
            t.next_recurrence_date, t.start_date, t.target_date, t.due_date,
            t.is_recurring_template, t.parent_task_id, t.recurrence_template_id,
            t.recurrence_instance_no, t.recurrence_end_type, t.status AS task_status,
            t.created_at
     FROM tasks t
     WHERE t.id = ANY($1::uuid[])
     ORDER BY t.title, t.created_at`,
    [ids]
  );

  const templateIds = [
    ...new Set(
      tasks.rows
        .map((r) => r.recurrence_template_id)
        .filter(Boolean)
    ),
  ];

  const templates =
    templateIds.length > 0
      ? await pool.query(
          `SELECT rt.id, rt.task_id, rt.title, rt.status, rt.recurrence_type,
                  rt.next_recurrence_date, rt.base_start_date, rt.base_due_offset, rt.base_target_offset,
                  rt.recurrence_end_type, rt.created_at,
                  (SELECT COUNT(*)::int FROM tasks ti WHERE ti.recurrence_template_id = rt.id) AS instance_count,
                  (SELECT MAX(ti.recurrence_instance_no)::int FROM tasks ti WHERE ti.recurrence_template_id = rt.id) AS max_instance_no
           FROM task_recurrence_templates rt
           WHERE rt.id = ANY($1::uuid[])`,
          [templateIds]
        )
      : { rows: [] };

  const templateById = Object.fromEntries(templates.rows.map((r) => [r.id, r]));

  const issues = [];

  for (const t of tasks.rows) {
      const rowIssues = [];

      if (t.task_type === 'one_time') {
        rowIssues.push('NOT_RECURRING: task_type is one_time');
      } else if (t.task_type !== 'recurring_instance' && t.task_type !== 'recurring_template') {
        rowIssues.push(`UNEXPECTED_TYPE: task_type=${t.task_type}`);
      }

      if (t.task_type === 'recurring_instance') {
        if (!t.recurrence_template_id) {
          rowIssues.push('NO_TEMPLATE_LINK: recurrence_template_id is null');
        }
        if (!t.start_date && !t.due_date) {
          rowIssues.push('NO_SCHEDULE_DATES: missing start_date and due_date');
        }
        const freq = (t.frequency || '').toLowerCase();
        const rtype = (t.recurrence_type || '').toLowerCase();
        if (freq === 'weekly' && rtype === 'daily') {
          rowIssues.push('FREQ_MISMATCH: frequency=weekly but recurrence_type=daily');
        }
        if (freq === 'daily' && rtype && rtype !== 'daily') {
          rowIssues.push(`FREQ_MISMATCH: frequency=daily vs recurrence_type=${rtype}`);
        }
        if (rtype === 'annually' && freq && freq !== 'yearly') {
          rowIssues.push(`FREQ_MISMATCH: recurrence_type=annually vs frequency=${freq}`);
        }

        const tmpl = t.recurrence_template_id ? templateById[t.recurrence_template_id] : null;
        if (t.recurrence_template_id && !tmpl) {
          rowIssues.push('ORPHAN_INSTANCE: template row missing in task_recurrence_templates');
        } else if (tmpl) {
          if (tmpl.status !== 'active') {
            rowIssues.push(`TEMPLATE_INACTIVE: template status=${tmpl.status}`);
          }
          if (!tmpl.next_recurrence_date) {
            rowIssues.push('TEMPLATE_NO_NEXT: template next_recurrence_date is null (will not generate more)');
          } else if (new Date(tmpl.next_recurrence_date) > new Date()) {
            rowIssues.push(`TEMPLATE_WAITING: next instance at ${tmpl.next_recurrence_date}`);
          }
          if (tmpl.recurrence_type !== t.recurrence_type) {
            rowIssues.push(
              `TEMPLATE_TYPE_MISMATCH: task recurrence_type=${t.recurrence_type} template=${tmpl.recurrence_type}`
            );
          }
        }

        if (t.next_recurrence_date) {
          rowIssues.push(
            'LEGACY_INSTANCE_CURSOR: task.next_recurrence_date set on instance (should be on template only)'
          );
        }
      }

      if (rowIssues.length) {
        issues.push({ id: t.id, title: t.title, task_type: t.task_type, issues: rowIssues });
      }
    }

  console.log('=== TASK ROWS FOUND ===', tasks.rows.length, 'of', ids.length);
  console.log('=== TEMPLATE ROWS ===', templates.rows.length);
  console.log(JSON.stringify(templates.rows, null, 2));
  console.log('=== ISSUES ===');
  console.log(JSON.stringify(issues, null, 2));

  const missing = ids.filter((id) => !tasks.rows.some((r) => r.id === id));
  if (missing.length) console.log('=== IDs NOT IN DB ===', missing);

  const legacyInList = await pool.query(
    `SELECT t.id, t.title, t.recurrence_template_id, t.parent_task_id,
            rt.id AS template_by_task_id, rt.status AS tmpl_status, rt.next_recurrence_date AS tmpl_next
     FROM tasks t
     LEFT JOIN task_recurrence_templates rt ON rt.task_id = t.id
     WHERE t.id = ANY($1::uuid[])
       AND t.task_type = 'recurring_instance'
       AND t.recurrence_template_id IS NULL`,
    [ids]
  );
  console.log('=== LEGACY (no recurrence_template_id on instance) ===');
  console.log(JSON.stringify(legacyInList.rows, null, 2));

  const withLink = tasks.rows.filter((r) => r.recurrence_template_id);
  console.log('=== PROPERLY LINKED INSTANCES ===', withLink.length);
  withLink.forEach((r) => console.log(`  ${r.title} -> template ${r.recurrence_template_id} #${r.recurrence_instance_no}`));

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
