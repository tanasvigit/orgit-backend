-- =====================================================
-- Migration: Make sender_organization_id nullable
-- Description: Organization ID is only required for group messages, not for direct messages
-- Date: 2026-01-05
-- =====================================================

-- Step 1: Drop the NOT NULL constraint on sender_organization_id
ALTER TABLE messages 
ALTER COLUMN sender_organization_id DROP NOT NULL;

-- Step 2: Update existing direct messages to have NULL organization_id
-- This updates messages in conversations that are NOT groups
UPDATE messages m
SET sender_organization_id = NULL
WHERE m.sender_organization_id IS NOT NULL
  AND m.conversation_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM conversations c 
    WHERE c.id = m.conversation_id 
    AND COALESCE(c.is_group, FALSE) = FALSE
    AND COALESCE(c.is_task_group, FALSE) = FALSE
  )
  AND m.receiver_id IS NULL
  AND m.group_id IS NULL;

-- Step 3: Add a comment to document the change
COMMENT ON COLUMN messages.sender_organization_id IS 
'Organization ID of the sender. Required for group messages (when group_id or is_group=true), NULL for direct messages.';

-- Verification query (optional - run to check results)
-- SELECT 
--   COUNT(*) as total_messages,
--   COUNT(sender_organization_id) as messages_with_org,
--   COUNT(*) - COUNT(sender_organization_id) as messages_without_org
-- FROM messages;

-- Check direct messages (should have NULL org_id)
-- SELECT 
--   m.id,
--   m.sender_id,
--   m.conversation_id,
--   m.sender_organization_id,
--   c.is_group,
--   c.is_task_group
-- FROM messages m
-- LEFT JOIN conversations c ON c.id = m.conversation_id
-- WHERE m.conversation_id IS NOT NULL
--   AND COALESCE(c.is_group, FALSE) = FALSE
--   AND COALESCE(c.is_task_group, FALSE) = FALSE
-- LIMIT 10;

