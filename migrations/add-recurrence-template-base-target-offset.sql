-- Preserve start → target spacing for recurring instance generation (in addition to start → due).
ALTER TABLE task_recurrence_templates
  ADD COLUMN IF NOT EXISTS base_target_offset INTERVAL NULL;
