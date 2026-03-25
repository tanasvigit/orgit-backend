-- Migration: Make sender_organization_id nullable for direct messages
-- Organization ID is only required for group messages, not for direct messages

-- First, drop the NOT NULL constraint
ALTER TABLE messages 
ALTER COLUMN sender_organization_id DROP NOT NULL;

-- Add a check constraint to ensure organization_id is provided for group messages
-- Note: This requires checking if it's a group message, which we'll handle in application logic
-- The database constraint ensures it's either NULL or a valid UUID reference

-- Update any existing direct messages (conversations that are not groups) to have NULL organization_id
-- This is a safety measure - you may want to review this before running
UPDATE messages m
SET sender_organization_id = NULL
WHERE m.sender_organization_id IS NOT NULL
  AND m.conversation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM conversations c 
    WHERE c.id = m.conversation_id 
    AND (c.is_group = TRUE OR c.is_task_group = TRUE)
  )
  AND m.receiver_id IS NULL
  AND m.group_id IS NULL;

-- Add a comment to document the change
COMMENT ON COLUMN messages.sender_organization_id IS 
'Organization ID of the sender. Required for group messages, NULL for direct messages.';

