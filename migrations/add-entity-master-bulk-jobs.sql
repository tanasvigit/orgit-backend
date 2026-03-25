-- Migration: add-entity-master-bulk-jobs
-- Purpose: Row-level queue for Entity Master (Employees, Service List, Entity List) with checkpoint

-- Add upload_type to entity_master_bulk_uploads: 'file' = file-level (current), 'employees'|'service_list'|'entity_list' = row-level
ALTER TABLE entity_master_bulk_uploads
  ADD COLUMN IF NOT EXISTS upload_type VARCHAR(20) NOT NULL DEFAULT 'file'
  CHECK (upload_type IN ('file', 'employees', 'service_list', 'entity_list'));

-- Make file_content nullable for row-level uploads (we store payloads in entity_master_bulk_jobs instead)
ALTER TABLE entity_master_bulk_uploads
  ALTER COLUMN file_content DROP NOT NULL;

-- Add total_rows for row-level uploads (for file-level it can stay 0 or we set 1)
ALTER TABLE entity_master_bulk_uploads
  ADD COLUMN IF NOT EXISTS total_rows INT NOT NULL DEFAULT 0;

-- Table: entity_master_bulk_jobs (one row per Excel row for row-level uploads)
CREATE TABLE IF NOT EXISTS entity_master_bulk_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    upload_id UUID NOT NULL REFERENCES entity_master_bulk_uploads(id) ON DELETE CASCADE,
    job_type VARCHAR(20) NOT NULL CHECK (job_type IN ('employee', 'service_list', 'entity_list')),
    row_index INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
    payload JSONB NOT NULL,
    error_message TEXT NULL,
    result_id UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ NULL,
    UNIQUE (upload_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_entity_master_bulk_jobs_upload_pending
  ON entity_master_bulk_jobs (upload_id, status) WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_entity_master_bulk_uploads_row_level
  ON entity_master_bulk_uploads (status, upload_type) WHERE upload_type IN ('employees', 'service_list', 'entity_list') AND status IN ('queued', 'queued_v2', 'processing', 'processing_v2');
