-- Migration: Add completed_at and verified_at columns to task_assignees table
-- These columns track when a member marks their task as complete and when the creator verifies it

-- Add completed_at column (timestamp when member marks task as complete)
ALTER TABLE task_assignees 
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP NULL;

-- Add verified_at column (timestamp when creator verifies the completion)
ALTER TABLE task_assignees 
ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP NULL;

-- Add comments to document the columns
COMMENT ON COLUMN task_assignees.completed_at IS 
'Timestamp when the assignee marked their task as complete. NULL if not completed yet.';

COMMENT ON COLUMN task_assignees.verified_at IS 
'Timestamp when the task creator verified the assignee''s completion. NULL if not verified yet. Only set when completed_at is also set.';

