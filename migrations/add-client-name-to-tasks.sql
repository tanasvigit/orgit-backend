-- Add free-text client name support directly on tasks
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS client_name VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_tasks_client_name ON tasks(client_name);
