-- Migration: Add reporting_member_id column to tasks table
-- This column stores which assignee is designated as the reporting member for the task
-- The reporting member has verification authority over other assignees (except themselves)

-- Add reporting_member_id column (UUID reference to users table)
ALTER TABLE tasks 
ADD COLUMN IF NOT EXISTS reporting_member_id UUID NULL;

-- Add foreign key constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'tasks_reporting_member_id_fkey'
    ) THEN
        ALTER TABLE tasks 
        ADD CONSTRAINT tasks_reporting_member_id_fkey 
        FOREIGN KEY (reporting_member_id) 
        REFERENCES users(id) 
        ON DELETE SET NULL;
    END IF;
END $$;

-- Add index for performance
CREATE INDEX IF NOT EXISTS idx_tasks_reporting_member_id 
ON tasks(reporting_member_id);

-- Add comment to document the column
COMMENT ON COLUMN tasks.reporting_member_id IS 
'UUID of the user designated as reporting member for this task. The reporting member can verify completions of other assignees (except themselves). NULL if no reporting member is designated.';

