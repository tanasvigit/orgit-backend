require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const owners = await pool.query(`
    SELECT DISTINCT COALESCE(created_by, creator_id) AS owner_id
    FROM tasks
    WHERE LOWER(TRIM(title)) IN ('daily', 'daily jun')
       OR LOWER(title) LIKE 'daily %'
  `);
  const ownerIds = owners.rows.map((r) => r.owner_id).filter(Boolean);
  if (!ownerIds.length) {
    console.log('No daily tasks or owners found.');
    await pool.end();
    return;
  }

  const ownerInfo = await pool.query(
    `SELECT id, name, mobile FROM users WHERE id = ANY($1::uuid[])`,
    [ownerIds]
  );

  const tasks = await pool.query(
    `SELECT t.id, t.title, t.task_type, t.frequency, t.recurrence_type,
            t.start_date, t.target_date, t.due_date, t.next_recurrence_date,
            t.recurrence_template_id, t.recurrence_instance_no, t.parent_task_id,
            t.status, t.created_by, t.creator_id, t.organization_id, t.created_at
     FROM tasks t
     WHERE (
       LOWER(TRIM(t.title)) IN ('daily', 'daily jun')
       OR LOWER(t.title) LIKE 'daily %'
       OR COALESCE(t.created_by, t.creator_id) = ANY($1::uuid[])
     )
     AND t.deleted_at IS NULL
     ORDER BY
       CASE WHEN LOWER(TRIM(t.title)) LIKE 'daily%' THEN 0 ELSE 1 END,
       t.created_at`,
    [ownerIds]
  );

  const templateIds = [
    ...new Set(tasks.rows.map((r) => r.recurrence_template_id).filter(Boolean)),
  ];
  const taskIds = tasks.rows.map((r) => r.id);

  const templates = await pool.query(
    `SELECT rt.id, rt.task_id, rt.title, rt.status, rt.recurrence_type,
            rt.next_recurrence_date, rt.base_start_date, rt.recurrence_end_type,
            rt.created_at,
            (SELECT COUNT(*)::int FROM tasks ti WHERE ti.recurrence_template_id = rt.id) AS instance_count,
            (SELECT MAX(ti.recurrence_instance_no)::int FROM tasks ti WHERE ti.recurrence_template_id = rt.id) AS max_instance_no
     FROM task_recurrence_templates rt
     WHERE rt.id = ANY($1::uuid[])
        OR rt.task_id = ANY($2::uuid[])`,
    [
      templateIds.length ? templateIds : ['00000000-0000-0000-0000-000000000000'],
      taskIds.length ? taskIds : ['00000000-0000-0000-0000-000000000000'],
    ]
  );

  const templateById = Object.fromEntries(templates.rows.map((r) => [r.id, r]));
  const templateByTaskId = Object.fromEntries(
    templates.rows.filter((r) => r.task_id).map((r) => [r.task_id, r])
  );

  const dailyNamed = tasks.rows.filter((r) =>
    /^daily(\s|$)/i.test(String(r.title || '').trim())
  );
  const ownerRelated = tasks.rows.filter(
    (r) => !/^daily(\s|$)/i.test(String(r.title || '').trim())
  );

  function assess(t) {
    const issues = [];
    const isDailyName = /^daily(\s|$)/i.test(String(t.title || '').trim());

    if (t.task_type === 'one_time') {
      return { recurring: false, label: 'One-time (not recurring)', issues: ['one_time'] };
    }

    if (t.task_type !== 'recurring_instance') {
      issues.push(`unexpected type: ${t.task_type}`);
    }

    const tmpl =
      (t.recurrence_template_id && templateById[t.recurrence_template_id]) ||
      templateByTaskId[t.id] ||
      null;

    if (!tmpl) {
      issues.push('no template row');
      return { recurring: false, label: 'Broken – no template', issues };
    }

    if (!t.recurrence_template_id) {
      issues.push('legacy anchor (recurrence_template_id empty on task)');
    }

    if (t.frequency === 'weekly' && t.recurrence_type === 'daily') {
      issues.push('frequency weekly vs recurrence_type daily');
    }

    if (!t.start_date && !t.due_date) {
      issues.push('missing start/due dates');
    }

    if (!tmpl.next_recurrence_date) {
      issues.push('template next_recurrence_date is null – will not generate');
      return { recurring: false, label: 'Broken – no next date', issues };
    }

    const next = new Date(tmpl.next_recurrence_date);
    const now = new Date();
    const waiting = next > now;

    return {
      recurring: true,
      label: waiting ? `Recurring – next ${next.toISOString().slice(0, 10)}` : 'Recurring – due for generation',
      issues,
      templateId: tmpl.id,
      instanceCount: tmpl.instance_count,
    };
  }

  console.log('=== DAILY TASK OWNER ===');
  console.log(JSON.stringify(ownerInfo.rows, null, 2));
  console.log('\n=== DAILY-NAMED TASKS (' + dailyNamed.length + ') ===\n');
  for (const t of dailyNamed) {
    const a = assess(t);
    console.log(`- ${t.title}`);
    console.log(`  id: ${t.id}`);
    console.log(`  type: ${t.task_type} | ${a.label}`);
    console.log(`  dates: start=${t.start_date ? new Date(t.start_date).toISOString().slice(0, 10) : '—'} due=${t.due_date ? new Date(t.due_date).toISOString().slice(0, 10) : '—'}`);
    if (t.recurrence_template_id) console.log(`  template_id: ${t.recurrence_template_id} instance #${t.recurrence_instance_no}`);
    if (a.issues.length) console.log(`  notes: ${a.issues.join('; ')}`);
    console.log('');
  }

  console.log('=== SAME OWNER – OTHER TASKS (' + ownerRelated.length + ') ===\n');
  for (const t of ownerRelated) {
    const a = assess(t);
    console.log(`- ${t.title}`);
    console.log(`  id: ${t.id}`);
    console.log(`  type: ${t.task_type} | ${a.label}`);
    if (a.issues.length) console.log(`  notes: ${a.issues.join('; ')}`);
    console.log('');
  }

  console.log('=== TEMPLATES FOR THIS OWNER’S DAILY SERIES ===');
  const dailyTemplates = templates.rows.filter(
    (rt) =>
      dailyNamed.some(
        (t) => t.id === rt.task_id || t.recurrence_template_id === rt.id
      ) || /^daily/i.test(rt.title || '')
  );
  console.log(JSON.stringify(dailyTemplates, null, 2));

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
