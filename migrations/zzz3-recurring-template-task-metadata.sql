-- Persist task tag (client_name) and org unit on recurrence templates so
-- generated instances always inherit metadata even if the anchor task row changes.

ALTER TABLE task_recurrence_templates
  ADD COLUMN IF NOT EXISTS client_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS client_entity_id UUID,
  ADD COLUMN IF NOT EXISTS org_structure_node_id UUID,
  ADD COLUMN IF NOT EXISTS org_structure_level_key VARCHAR(100),
  ADD COLUMN IF NOT EXISTS org_structure_path JSONB;

-- Backfill from the anchor task linked at template creation time.
UPDATE task_recurrence_templates trt
SET
  client_name = COALESCE(NULLIF(TRIM(t.client_name), ''), trt.client_name),
  client_entity_id = COALESCE(t.client_entity_id, trt.client_entity_id),
  org_structure_node_id = COALESCE(t.org_structure_node_id, trt.org_structure_node_id),
  org_structure_level_key = COALESCE(t.org_structure_level_key, trt.org_structure_level_key),
  org_structure_path = COALESCE(t.org_structure_path, trt.org_structure_path)
FROM tasks t
WHERE trt.task_id = t.id
  AND (
    trt.client_name IS NULL
    OR trt.org_structure_path IS NULL
    OR trt.org_structure_node_id IS NULL
  );
