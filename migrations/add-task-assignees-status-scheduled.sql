-- Migration: add-task-assignees-status-scheduled
-- Purpose: allow 'scheduled' in task_assignees.status so creator/assignee can be marked scheduled
-- when start_date <= created_at (task not shown on dashboard until start_date > created_at).

DO $$
DECLARE
  conname text;
BEGIN
  SELECT c.conname INTO conname
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  WHERE t.relname = 'task_assignees' AND c.contype = 'c' AND c.conname LIKE '%status%'
  LIMIT 1;
  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE task_assignees DROP CONSTRAINT %I', conname);
  END IF;
END $$;

ALTER TABLE task_assignees
  ADD CONSTRAINT task_assignees_status_check
  CHECK (status IN ('todo', 'inprogress', 'duesoon', 'overdue', 'completed', 'scheduled'));
