-- Add is_pinned to conversation_members for pinning conversations per user.
-- Safe to run multiple times (adds column only if missing).

ALTER TABLE conversation_members
ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN conversation_members.is_pinned IS 'Whether this user has pinned the conversation in their list';
