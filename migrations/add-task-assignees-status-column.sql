-- Migration: add-task-assignees-status-column
-- Purpose: per-user task status lifecycle (todo, inprogress, duesoon, overdue, completed)

ALTER TABLE task_assignees
ADD COLUMN IF NOT EXISTS status VARCHAR(50)
  CHECK (status IN ('todo', 'inprogress', 'duesoon', 'overdue', 'completed'));

CREATE INDEX IF NOT EXISTS idx_task_assignees_status
  ON task_assignees(status);

