-- Allow v2 queue statuses used by hardened Entity Master worker.
-- This prevents legacy workers from picking new uploads while preserving old statuses.

ALTER TABLE entity_master_bulk_uploads
DROP CONSTRAINT IF EXISTS entity_master_bulk_uploads_status_check;

ALTER TABLE entity_master_bulk_uploads
ADD CONSTRAINT entity_master_bulk_uploads_status_check
CHECK (status IN (
  'queued',
  'queued_v2',
  'processing',
  'processing_v2',
  'completed',
  'failed',
  'cancelled'
));

DROP INDEX IF EXISTS idx_entity_master_bulk_uploads_status;
CREATE INDEX IF NOT EXISTS idx_entity_master_bulk_uploads_status
ON entity_master_bulk_uploads (status)
WHERE status IN ('queued', 'queued_v2', 'processing', 'processing_v2');

DROP INDEX IF EXISTS idx_entity_master_bulk_uploads_rowlevel_status;
CREATE INDEX IF NOT EXISTS idx_entity_master_bulk_uploads_rowlevel_status
ON entity_master_bulk_uploads (status, upload_type)
WHERE upload_type IN ('employees', 'service_list', 'entity_list')
  AND status IN ('queued', 'queued_v2', 'processing', 'processing_v2');
