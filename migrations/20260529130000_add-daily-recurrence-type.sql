-- Allow daily recurrence_type on tasks (web/mobile send recurrence_type = 'daily')

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_recurrence_type_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_recurrence_type_check
  CHECK (
    recurrence_type IS NULL
    OR recurrence_type IN ('daily', 'weekly', 'monthly', 'quarterly', 'annually')
  );
