-- Allow daily as a tasks.frequency value (matches recurrence_type = 'daily')

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_frequency_check;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_frequency_check
  CHECK (
    frequency IS NULL
    OR frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'specific_weekday')
  );
