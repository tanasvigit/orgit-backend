-- Optional JSON payload for system / rich messages (task delete/exit flows, etc.)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT NULL;
