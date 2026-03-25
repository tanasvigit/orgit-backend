-- Migration: add-task-roles-and-client
-- Purpose:
-- 1) Store task roles (creator, reporting_member, member) in task_assignees
-- 2) Add client_entity_id and end_date to tasks
-- 3) Backfill roles for existing data based on tasks.creator_id/created_by and tasks.reporting_member_id

BEGIN;

-- 1) Add client link + end_date to tasks
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS client_entity_id UUID NULL REFERENCES client_entities(id) ON DELETE SET NULL;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS end_date TIMESTAMP NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_client_entity_id ON tasks(client_entity_id);

-- 2) Add role to task_assignees
ALTER TABLE task_assignees
  ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'member'
  CHECK (role IN ('creator', 'reporting_member', 'member'));

-- Ensure existing rows have a non-null role
UPDATE task_assignees SET role = COALESCE(role, 'member') WHERE role IS NULL;

-- 3) Backfill roles from tasks table (denormalized columns)
-- Creator: prefer created_by (legacy) then creator_id
UPDATE task_assignees ta
SET role = 'creator'
FROM tasks t
WHERE ta.task_id = t.id
  AND ta.user_id = COALESCE(t.created_by, t.creator_id);

-- Reporting member: do not override creator
UPDATE task_assignees ta
SET role = 'reporting_member'
FROM tasks t
WHERE ta.task_id = t.id
  AND t.reporting_member_id IS NOT NULL
  AND ta.user_id = t.reporting_member_id
  AND ta.role <> 'creator';

-- Remaining: member
UPDATE task_assignees
SET role = 'member'
WHERE role IS NULL;

-- 4) Enforce one creator and one reporting member per task (partial unique indexes)
-- Note: uses indexes instead of constraints to allow partial uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS ux_task_assignees_one_creator_per_task
  ON task_assignees(task_id)
  WHERE role = 'creator';

CREATE UNIQUE INDEX IF NOT EXISTS ux_task_assignees_one_reporting_member_per_task
  ON task_assignees(task_id)
  WHERE role = 'reporting_member';

COMMIT;

