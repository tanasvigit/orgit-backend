-- Immutable recurring architecture:
-- - Introduce recurrence templates.
-- - Create recurring instances as new task rows.
-- - Stop reusing the same task row across cycles.

-- 1) Extend tasks.task_type to include recurring_instance and recurring_template.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'tasks'
      AND constraint_type = 'CHECK'
      AND constraint_name LIKE '%task_type%'
  ) THEN
    ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_task_type_check;
  END IF;
END $$;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_task_type_check
  CHECK (task_type IN ('one_time', 'recurring', 'recurring_template', 'recurring_instance'));

-- 2) Add instance linkage columns on tasks.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS is_recurring_template BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS parent_task_id UUID NULL,
  ADD COLUMN IF NOT EXISTS recurrence_template_id UUID NULL,
  ADD COLUMN IF NOT EXISTS recurrence_instance_no INTEGER NULL,
  ADD COLUMN IF NOT EXISTS recurrence_day_of_month INTEGER NULL;

-- 3) Recurrence template table.
CREATE TABLE IF NOT EXISTS task_recurrence_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NULL REFERENCES tasks(id) ON DELETE SET NULL,
  organization_id UUID NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT NULL,
  category VARCHAR(100) NULL,
  creator_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  reporting_member_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  recurrence_type VARCHAR(50) NULL,
  recurrence_interval INTEGER NOT NULL DEFAULT 1,
  recurrence_day_of_month INTEGER NULL,
  specific_weekday INTEGER NULL,
  base_start_date TIMESTAMP NULL,
  base_due_offset INTERVAL NULL,
  last_generated_at TIMESTAMP NULL,
  next_recurrence_date TIMESTAMP NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'tasks'
      AND constraint_name = 'tasks_recurrence_template_fk'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_recurrence_template_fk
      FOREIGN KEY (recurrence_template_id) REFERENCES task_recurrence_templates(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'tasks'
      AND constraint_name = 'tasks_parent_task_template_fk'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_parent_task_template_fk
      FOREIGN KEY (parent_task_id) REFERENCES task_recurrence_templates(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 4) Template assignee blueprint table.
CREATE TABLE IF NOT EXISTS task_template_assignees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES task_recurrence_templates(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL DEFAULT 'member',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (template_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_task_recurrence_templates_next
  ON task_recurrence_templates(next_recurrence_date);
CREATE INDEX IF NOT EXISTS idx_task_recurrence_templates_status
  ON task_recurrence_templates(status);
CREATE INDEX IF NOT EXISTS idx_tasks_recurrence_template_id
  ON tasks(recurrence_template_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id
  ON tasks(parent_task_id);

-- 5) Backfill existing recurring tasks into template+instance linkage.
WITH recurring_source AS (
  SELECT
    t.id AS task_id,
    t.organization_id,
    t.title,
    t.description,
    t.category,
    COALESCE(t.created_by, t.creator_id) AS creator_id,
    t.reporting_member_id,
    COALESCE(NULLIF(t.recurrence_type, ''), 'monthly') AS recurrence_type,
    COALESCE(t.recurrence_interval, 1) AS recurrence_interval,
    t.recurrence_day_of_month,
    t.specific_weekday,
    t.start_date,
    t.next_recurrence_date,
    CASE
      WHEN t.start_date IS NOT NULL AND t.due_date IS NOT NULL THEN t.due_date - t.start_date
      ELSE NULL
    END AS base_due_offset
  FROM tasks t
  WHERE t.task_type = 'recurring'
),
inserted_templates AS (
  INSERT INTO task_recurrence_templates (
    task_id,
    organization_id,
    title,
    description,
    category,
    creator_id,
    reporting_member_id,
    recurrence_type,
    recurrence_interval,
    recurrence_day_of_month,
    specific_weekday,
    base_start_date,
    base_due_offset,
    next_recurrence_date,
    status
  )
  SELECT
    rs.task_id,
    rs.organization_id,
    rs.title,
    rs.description,
    rs.category,
    rs.creator_id,
    rs.reporting_member_id,
    rs.recurrence_type,
    rs.recurrence_interval,
    rs.recurrence_day_of_month,
    rs.specific_weekday,
    rs.start_date,
    rs.base_due_offset,
    rs.next_recurrence_date,
    'active'
  FROM recurring_source rs
  WHERE NOT EXISTS (
    SELECT 1
    FROM task_recurrence_templates trt
    WHERE trt.task_id = rs.task_id
  )
  RETURNING id, task_id
)
UPDATE tasks t
SET
  is_recurring_template = FALSE,
  task_type = 'recurring_instance',
  recurrence_template_id = it.id,
  parent_task_id = it.id,
  recurrence_instance_no = COALESCE(t.recurrence_instance_no, 1)
FROM inserted_templates it
WHERE t.id = it.task_id;

-- Align pre-existing linked templates too (idempotency).
UPDATE tasks t
SET
  is_recurring_template = FALSE,
  task_type = 'recurring_instance',
  recurrence_template_id = trt.id,
  parent_task_id = trt.id,
  recurrence_instance_no = COALESCE(t.recurrence_instance_no, 1)
FROM task_recurrence_templates trt
WHERE trt.task_id = t.id
  AND t.task_type = 'recurring';

-- 6) Backfill template assignees.
INSERT INTO task_template_assignees (template_id, user_id, role)
SELECT
  trt.id,
  ta.user_id,
  COALESCE(ta.role, 'member')
FROM task_recurrence_templates trt
JOIN task_assignees ta ON ta.task_id = trt.task_id
ON CONFLICT (template_id, user_id) DO NOTHING;
