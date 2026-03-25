-- Migration: add reply_to_message_id to messages (fixes "column m.reply_to_message_id does not exist")
-- Run this if your DB was created from an older schema that didn't include this column.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'reply_to_message_id'
  ) THEN
    ALTER TABLE messages
      ADD COLUMN reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_reply_to_message_id ON messages(reply_to_message_id);
    RAISE NOTICE 'Added column messages.reply_to_message_id and index.';
  ELSE
    RAISE NOTICE 'Column messages.reply_to_message_id already exists.';
  END IF;
END $$;
