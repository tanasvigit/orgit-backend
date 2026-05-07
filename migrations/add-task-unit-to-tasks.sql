-- Add task_unit column to tasks so UI Task Unit field is persisted.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'tasks'
      AND column_name = 'task_unit'
  ) THEN
    ALTER TABLE tasks ADD COLUMN task_unit VARCHAR(255);
  END IF;
END $$;

