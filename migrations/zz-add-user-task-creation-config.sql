-- Per-user defaults for task creation (start/target/due spacing and auto-escalation trigger preference).

ALTER TABLE users ADD COLUMN IF NOT EXISTS task_creation_user_config JSONB DEFAULT NULL;

COMMENT ON COLUMN users.task_creation_user_config IS 'User preferences: dueDaysFromStart, targetDaysBeforeDue, autoEscalateTrigger (target_date|due_date). Null = use system defaults.';
