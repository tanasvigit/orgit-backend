-- Migration: add-task-rollout-and-recurrence-columns
-- Purpose: support recurring task rollout behavior and richer recurrence metadata

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS task_rollout_type VARCHAR(50)
    CHECK (task_rollout_type IN ('cycle_start', 'start_date')),
ADD COLUMN IF NOT EXISTS recurrence_type VARCHAR(50)
    CHECK (recurrence_type IN ('weekly', 'monthly', 'quarterly', 'annually')),
ADD COLUMN IF NOT EXISTS recurrence_interval INTEGER,
ADD COLUMN IF NOT EXISTS escalation_status VARCHAR(50),
ADD COLUMN IF NOT EXISTS auto_escalate BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS escalation_rules JSONB,
ADD COLUMN IF NOT EXISTS document_instance_id UUID,
ADD COLUMN IF NOT EXISTS category VARCHAR(100),
ADD COLUMN IF NOT EXISTS compliance_id UUID,
ADD COLUMN IF NOT EXISTS financial_value NUMERIC(12, 2),
ADD COLUMN IF NOT EXISTS finance_type VARCHAR(20)
    CHECK (finance_type IN ('income', 'expense'));

