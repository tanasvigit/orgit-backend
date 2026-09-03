-- Phase 1 task lifecycle and workflow tables

-- Ensure tasks.status exists (base schema normally has it)
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS verification_status VARCHAR(20) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS completed_by_assignee_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS verified_by_owner_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) DEFAULT NULL;

DO $$
DECLARE
  conname text;
BEGIN
  FOR conname IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'tasks'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%status%'
      AND pg_get_constraintdef(c.oid) NOT ILIKE '%verification_status%'
  LOOP
    EXECUTE format('ALTER TABLE tasks DROP CONSTRAINT %I', conname);
  END LOOP;
END $$;

ALTER TABLE tasks
  ADD CONSTRAINT tasks_status_check
  CHECK (status IN (
    'pending',
    'todo',
    'active',
    'in_progress',
    'pending_verification',
    'completed',
    'cancelled',
    'overdue',
    'rejected',
    'deleted'
  ));

CREATE TABLE IF NOT EXISTS task_delete_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_delete_requests_task_id ON task_delete_requests(task_id);
CREATE INDEX IF NOT EXISTS idx_task_delete_requests_status ON task_delete_requests(status);

CREATE TABLE IF NOT EXISTS task_exit_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  assignee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_exit_requests_task_id ON task_exit_requests(task_id);
CREATE INDEX IF NOT EXISTS idx_task_exit_requests_status ON task_exit_requests(status);

DO $$
DECLARE
  conname text;
BEGIN
  FOR conname IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'notifications'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%type%'
  LOOP
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', conname);
  END LOOP;
END $$;

ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'message_received',
    'task_assigned',
    'task_accepted',
    'task_rejected',
    'task_updated',
    'task_overdue',
    'task_escalated',
    'group_member_added',
    'document_shared',
    'TASK_STATUS_CHANGED',
    'TASK_COMPLETE_PENDING',
    'TASK_VERIFIED',
    'TASK_COMPLETION_REJECTED',
    'TASK_DELETED',
    'EXIT_REQUEST_RECEIVED',
    'EXIT_APPROVED',
    'EXIT_REJECTED',
    'DELETE_REQUEST_RECEIVED',
    'MEMBER_ADDED'
  ));

-- status column is normally added by add-task-assignees-status-column.sql,
-- which sorts AFTER this file — ensure it exists before updating the check.
ALTER TABLE task_assignees
  ADD COLUMN IF NOT EXISTS status VARCHAR(50);

DO $$
DECLARE
  conname text;
BEGIN
  FOR conname IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'task_assignees'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE task_assignees DROP CONSTRAINT %I', conname);
  END LOOP;
END $$;

ALTER TABLE task_assignees
  ADD CONSTRAINT task_assignees_status_check
  CHECK (status IS NULL OR status IN ('todo', 'inprogress', 'duesoon', 'overdue', 'completed', 'scheduled', 'exited'));
