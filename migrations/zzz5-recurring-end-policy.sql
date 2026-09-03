-- Recurrence end policy: never | specific_date | after_occurrences (all frequencies)

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS recurrence_end_type VARCHAR(32)
    CHECK (recurrence_end_type IN ('never', 'specific_date', 'after_occurrences')),
  ADD COLUMN IF NOT EXISTS recurrence_end_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recurrence_after_occurrences INTEGER
    CHECK (recurrence_after_occurrences IS NULL OR recurrence_after_occurrences > 0);

ALTER TABLE task_recurrence_templates
  ADD COLUMN IF NOT EXISTS recurrence_end_type VARCHAR(32)
    CHECK (recurrence_end_type IN ('never', 'specific_date', 'after_occurrences')),
  ADD COLUMN IF NOT EXISTS recurrence_end_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recurrence_after_occurrences INTEGER
    CHECK (recurrence_after_occurrences IS NULL OR recurrence_after_occurrences > 0);
