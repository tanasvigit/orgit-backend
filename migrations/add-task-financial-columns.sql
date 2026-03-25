-- Migration: add-task-financial-columns
-- Purpose: store financial value and finance type on tasks

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS financial_value NUMERIC(12, 2),
ADD COLUMN IF NOT EXISTS finance_type VARCHAR(20) CHECK (finance_type IN ('income', 'expense'));

