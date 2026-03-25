-- Migration: add-messages-reply-and-deleted-for-all
-- Purpose: add reply_to_message_id and deleted_for_all to messages (used by getMessagesByConversationId and others)

ALTER TABLE messages
ADD COLUMN IF NOT EXISTS reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS deleted_for_all BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to_message_id ON messages(reply_to_message_id);
