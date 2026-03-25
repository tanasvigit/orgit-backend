-- Migration: Add document_instance_id column to tasks table
-- Links a task to a document instance when the task was created from a document (e.g. after PDF generation)

ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS document_instance_id UUID NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tasks_document_instance_id_fkey'
    ) THEN
        ALTER TABLE tasks
        ADD CONSTRAINT tasks_document_instance_id_fkey
        FOREIGN KEY (document_instance_id)
        REFERENCES document_instances(id)
        ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_document_instance_id
ON tasks(document_instance_id);

COMMENT ON COLUMN tasks.document_instance_id IS
'UUID of the document instance this task was created from (document management flow). NULL for non-document tasks.';
