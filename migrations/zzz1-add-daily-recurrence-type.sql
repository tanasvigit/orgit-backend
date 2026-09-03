-- Allow daily recurrence_type on tasks (web/mobile send recurrence_type = 'daily')
-- Must run AFTER add-task-rollout-and-recurrence-columns.sql (creates recurrence_type).

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS recurrence_type VARCHAR(50);

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_recurrence_type_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_recurrence_type_check
  CHECK (
    recurrence_type IS NULL
    OR recurrence_type IN ('daily', 'weekly', 'monthly', 'quarterly', 'annually')
  );
