-- Per-task auto-escalation trigger fields (used by cron + task create API)

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS escalation_trigger VARCHAR(32),
ADD COLUMN IF NOT EXISTS escalation_days_before INTEGER DEFAULT 0;

COMMENT ON COLUMN tasks.escalation_trigger IS 'target_date or due_date — anchor date for auto escalation';
COMMENT ON COLUMN tasks.escalation_days_before IS 'Escalate when CURRENT_DATE >= anchor_date minus this many days';

UPDATE tasks SET escalation_status = 'none' WHERE escalation_status IS NULL;
