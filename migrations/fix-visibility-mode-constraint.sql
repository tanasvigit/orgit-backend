-- =====================================================
-- Migration: Fix visibility_mode constraint to allow 'private'
-- Description: Allow 'private' visibility mode for individual/personal chats
-- Date: 2026-02-09
-- =====================================================

-- Step 1: Drop the existing constraint (if it exists)
ALTER TABLE messages 
DROP CONSTRAINT IF EXISTS messages_visibility_mode_check;

-- Step 2: Add the constraint with 'private' included
ALTER TABLE messages 
ADD CONSTRAINT messages_visibility_mode_check 
CHECK (visibility_mode IN ('shared_to_group', 'org_only', 'private'));

-- Step 3: Add a comment to document the change
COMMENT ON COLUMN messages.visibility_mode IS 
'Visibility mode: shared_to_group (visible to all group members), org_only (visible only to members from same organization), private (for direct/individual conversations between two users)';
