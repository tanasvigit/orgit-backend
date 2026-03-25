-- Migration: add-bulk-upload-queue
-- Purpose: Queue and checkpoint for Excel bulk uploads (Tasks row-level, Entity Master file-level)

-- Task bulk: one row per upload, N jobs per upload (one per Excel row)
CREATE TABLE IF NOT EXISTS task_bulk_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    total_rows INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
    processed_count INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS task_bulk_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    upload_id UUID NOT NULL REFERENCES task_bulk_uploads(id) ON DELETE CASCADE,
    row_index INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
    payload JSONB NOT NULL,
    error_message TEXT NULL,
    task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ NULL,
    UNIQUE (upload_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_task_bulk_jobs_upload_pending ON task_bulk_jobs (upload_id, status) WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_task_bulk_uploads_status ON task_bulk_uploads (status) WHERE status IN ('queued', 'processing');

-- Entity Master bulk: one row per upload (file-level job)
CREATE TABLE IF NOT EXISTS entity_master_bulk_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'queued_v2', 'processing', 'processing_v2', 'completed', 'failed', 'cancelled')),
    processed_count INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    file_content BYTEA NOT NULL,
    metadata JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ NULL,
    error_summary JSONB NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_master_bulk_uploads_status ON entity_master_bulk_uploads (status) WHERE status IN ('queued', 'queued_v2', 'processing', 'processing_v2');
