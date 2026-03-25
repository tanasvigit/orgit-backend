-- Migration: Add document_id column to tasks table
-- Links a task to a user document when the task was created from Document Access (user_documents flow)

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS document_id UUID NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tasks_document_id_fkey'
    ) THEN
        ALTER TABLE tasks
        ADD CONSTRAINT tasks_document_id_fkey
        FOREIGN KEY (document_id)
        REFERENCES user_documents(id)
        ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_document_id
ON tasks(document_id);

COMMENT ON COLUMN tasks.document_id IS
'UUID of the user document this task was created from (Document Access flow). NULL for non-document tasks.';
