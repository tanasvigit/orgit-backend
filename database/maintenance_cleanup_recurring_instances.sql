-- Maintenance script: cleanup runaway recurring instances and repair template cursors.
-- Safe-by-default workflow:
--   1) Run PREVIEW queries first.
--   2) Set target_template_id to scope (or keep NULL for all templates).
--   3) Run FIX section inside a transaction.
--
-- IMPORTANT:
-- - This script intentionally keeps ONE row per (recurrence_template_id, start_date).
-- - Duplicates are deleted by keeping earliest created_at (then lowest id).
-- - Recurrence cursor repair skips backlog and moves next_recurrence_date to first future slot.

/* =======================
   PREVIEW SECTION
   ======================= */

-- Set to a specific UUID to limit to one template, or keep NULL for all templates.
WITH params AS (
  SELECT NULL::uuid AS target_template_id
),
dupe_groups AS (
  SELECT
    t.recurrence_template_id,
    t.start_date,
    COUNT(*) AS duplicate_count
  FROM tasks t, params p
  WHERE t.recurrence_template_id IS NOT NULL
    AND (p.target_template_id IS NULL OR t.recurrence_template_id = p.target_template_id)
  GROUP BY t.recurrence_template_id, t.start_date
  HAVING COUNT(*) > 1
)
SELECT
  recurrence_template_id,
  start_date,
  duplicate_count
FROM dupe_groups
ORDER BY duplicate_count DESC, recurrence_template_id, start_date;

-- Preview total rows that would be deleted.
WITH params AS (
  SELECT NULL::uuid AS target_template_id
),
ranked AS (
  SELECT
    t.id,
    ROW_NUMBER() OVER (
      PARTITION BY t.recurrence_template_id, t.start_date
      ORDER BY t.created_at ASC, t.id ASC
    ) AS rn
  FROM tasks t, params p
  WHERE t.recurrence_template_id IS NOT NULL
    AND (p.target_template_id IS NULL OR t.recurrence_template_id = p.target_template_id)
)
SELECT COUNT(*) AS rows_to_delete
FROM ranked
WHERE rn > 1;

-- Preview templates whose cursor is stale (<= now) and would be repaired.
WITH params AS (
  SELECT NULL::uuid AS target_template_id
)
SELECT
  rtt.id AS template_id,
  rtt.recurrence_type,
  rtt.specific_weekday,
  rtt.next_recurrence_date
FROM task_recurrence_templates rtt, params p
WHERE rtt.status = 'active'
  AND rtt.next_recurrence_date IS NOT NULL
  AND rtt.next_recurrence_date <= NOW()
  AND (p.target_template_id IS NULL OR rtt.id = p.target_template_id)
ORDER BY rtt.next_recurrence_date ASC;


/* =======================
   FIX SECTION
   ======================= */

BEGIN;

-- Optional: lock tables to avoid concurrent scheduler races during cleanup.
LOCK TABLE tasks IN ROW EXCLUSIVE MODE;
LOCK TABLE task_recurrence_templates IN ROW EXCLUSIVE MODE;

-- 1) Delete duplicate instances, keep earliest row per template+start_date.
WITH params AS (
  SELECT NULL::uuid AS target_template_id
),
ranked AS (
  SELECT
    t.id,
    ROW_NUMBER() OVER (
      PARTITION BY t.recurrence_template_id, t.start_date
      ORDER BY t.created_at ASC, t.id ASC
    ) AS rn
  FROM tasks t, params p
  WHERE t.recurrence_template_id IS NOT NULL
    AND (p.target_template_id IS NULL OR t.recurrence_template_id = p.target_template_id)
),
to_delete AS (
  SELECT id
  FROM ranked
  WHERE rn > 1
)
DELETE FROM tasks t
USING to_delete d
WHERE t.id = d.id;

-- 2) Resequence recurrence_instance_no after cleanup.
WITH params AS (
  SELECT NULL::uuid AS target_template_id
),
ordered AS (
  SELECT
    t.id,
    ROW_NUMBER() OVER (
      PARTITION BY t.recurrence_template_id
      ORDER BY t.start_date ASC, t.created_at ASC, t.id ASC
    ) AS new_instance_no
  FROM tasks t, params p
  WHERE t.recurrence_template_id IS NOT NULL
    AND (p.target_template_id IS NULL OR t.recurrence_template_id = p.target_template_id)
),
updated AS (
  UPDATE tasks t
  SET recurrence_instance_no = o.new_instance_no
  FROM ordered o
  WHERE t.id = o.id
    AND (t.recurrence_instance_no IS DISTINCT FROM o.new_instance_no)
  RETURNING t.id
)
SELECT COUNT(*) AS resequenced_rows FROM updated;

-- 3) Repair stale cursors: move directly to first future occurrence.
WITH RECURSIVE params AS (
  SELECT NULL::uuid AS target_template_id
),
seed AS (
  SELECT
    rtt.id AS template_id,
    LOWER(COALESCE(rtt.recurrence_type, 'monthly')) AS recurrence_type,
    rtt.specific_weekday,
    rtt.next_recurrence_date AS cursor_date
  FROM task_recurrence_templates rtt, params p
  WHERE rtt.status = 'active'
    AND rtt.next_recurrence_date IS NOT NULL
    AND rtt.next_recurrence_date <= NOW()
    AND (p.target_template_id IS NULL OR rtt.id = p.target_template_id)
),
stepped AS (
  SELECT
    s.template_id,
    s.recurrence_type,
    s.specific_weekday,
    s.cursor_date,
    CASE
      WHEN s.recurrence_type = 'specific_weekday' AND s.specific_weekday IS NOT NULL THEN
        s.cursor_date
        + (
            CASE
              WHEN ((s.specific_weekday - EXTRACT(DOW FROM s.cursor_date)::int + 7) % 7) = 0 THEN 7
              ELSE ((s.specific_weekday - EXTRACT(DOW FROM s.cursor_date)::int + 7) % 7)
            END
          ) * INTERVAL '1 day'
      WHEN s.recurrence_type = 'weekly' THEN s.cursor_date + INTERVAL '7 day'
      WHEN s.recurrence_type = 'quarterly' THEN s.cursor_date + INTERVAL '3 month'
      WHEN s.recurrence_type IN ('yearly', 'annually') THEN s.cursor_date + INTERVAL '1 year'
      ELSE s.cursor_date + INTERVAL '1 month'
    END AS next_date,
    1 AS depth
  FROM seed s

  UNION ALL

  SELECT
    st.template_id,
    st.recurrence_type,
    st.specific_weekday,
    st.next_date AS cursor_date,
    CASE
      WHEN st.recurrence_type = 'specific_weekday' AND st.specific_weekday IS NOT NULL THEN
        st.next_date
        + (
            CASE
              WHEN ((st.specific_weekday - EXTRACT(DOW FROM st.next_date)::int + 7) % 7) = 0 THEN 7
              ELSE ((st.specific_weekday - EXTRACT(DOW FROM st.next_date)::int + 7) % 7)
            END
          ) * INTERVAL '1 day'
      WHEN st.recurrence_type = 'weekly' THEN st.next_date + INTERVAL '7 day'
      WHEN st.recurrence_type = 'quarterly' THEN st.next_date + INTERVAL '3 month'
      WHEN st.recurrence_type IN ('yearly', 'annually') THEN st.next_date + INTERVAL '1 year'
      ELSE st.next_date + INTERVAL '1 month'
    END AS next_date,
    st.depth + 1 AS depth
  FROM stepped st
  WHERE st.next_date <= NOW()
    AND st.depth < 500
),
final_next AS (
  SELECT DISTINCT ON (template_id)
    template_id,
    next_date AS repaired_next_recurrence_date
  FROM stepped
  WHERE next_date > NOW()
  ORDER BY template_id, depth DESC
),
updated AS (
  UPDATE task_recurrence_templates rtt
  SET
    next_recurrence_date = f.repaired_next_recurrence_date,
    updated_at = NOW()
  FROM final_next f
  WHERE rtt.id = f.template_id
  RETURNING rtt.id
)
SELECT COUNT(*) AS repaired_templates FROM updated;

COMMIT;

-- If needed, replace COMMIT with ROLLBACK during dry-runs.

