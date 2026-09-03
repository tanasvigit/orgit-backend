-- Backfill tag (client_name) and org unit on recurring instances that were
-- generated before template snapshot / copy fixes. Safe to re-run (idempotent).

-- 1) Ensure templates have metadata from their anchor task.
UPDATE task_recurrence_templates trt
SET
  client_name = COALESCE(NULLIF(TRIM(trt.client_name), ''), NULLIF(TRIM(anchor.client_name), '')),
  client_entity_id = COALESCE(trt.client_entity_id, anchor.client_entity_id),
  org_structure_node_id = COALESCE(trt.org_structure_node_id, anchor.org_structure_node_id),
  org_structure_level_key = COALESCE(trt.org_structure_level_key, anchor.org_structure_level_key),
  org_structure_path = COALESCE(trt.org_structure_path, anchor.org_structure_path),
  updated_at = NOW()
FROM tasks anchor
WHERE trt.task_id = anchor.id
  AND (
    NULLIF(TRIM(COALESCE(trt.client_name, '')), '') IS NULL
    OR trt.org_structure_path IS NULL
    OR trt.org_structure_node_id IS NULL
  );

-- 2) If any instance under a template already has metadata, promote it to the template.
WITH richest_instance AS (
  SELECT DISTINCT ON (t.recurrence_template_id)
    t.recurrence_template_id AS template_id,
    NULLIF(TRIM(t.client_name), '') AS client_name,
    t.client_entity_id,
    t.org_structure_node_id,
    t.org_structure_level_key,
    t.org_structure_path
  FROM tasks t
  WHERE t.recurrence_template_id IS NOT NULL
    AND (
      NULLIF(TRIM(COALESCE(t.client_name, '')), '') IS NOT NULL
      OR t.org_structure_path IS NOT NULL
      OR t.org_structure_node_id IS NOT NULL
    )
  ORDER BY
    t.recurrence_template_id,
    COALESCE(t.recurrence_instance_no, 0) DESC,
    t.created_at DESC
)
UPDATE task_recurrence_templates trt
SET
  client_name = COALESCE(NULLIF(TRIM(trt.client_name), ''), ri.client_name),
  client_entity_id = COALESCE(trt.client_entity_id, ri.client_entity_id),
  org_structure_node_id = COALESCE(trt.org_structure_node_id, ri.org_structure_node_id),
  org_structure_level_key = COALESCE(trt.org_structure_level_key, ri.org_structure_level_key),
  org_structure_path = COALESCE(trt.org_structure_path, ri.org_structure_path),
  updated_at = NOW()
FROM richest_instance ri
WHERE trt.id = ri.template_id
  AND (
    NULLIF(TRIM(COALESCE(trt.client_name, '')), '') IS NULL
    OR trt.org_structure_path IS NULL
    OR trt.org_structure_node_id IS NULL
  );

-- 3) Copy template metadata onto every instance that is still missing it.
UPDATE tasks inst
SET
  client_name = COALESCE(NULLIF(TRIM(inst.client_name), ''), NULLIF(TRIM(trt.client_name), '')),
  client_entity_id = COALESCE(inst.client_entity_id, trt.client_entity_id),
  org_structure_node_id = COALESCE(inst.org_structure_node_id, trt.org_structure_node_id),
  org_structure_level_key = COALESCE(inst.org_structure_level_key, trt.org_structure_level_key),
  org_structure_path = COALESCE(inst.org_structure_path, trt.org_structure_path),
  updated_at = NOW()
FROM task_recurrence_templates trt
WHERE inst.recurrence_template_id = trt.id
  AND (
    NULLIF(TRIM(COALESCE(inst.client_name, '')), '') IS NULL
    OR inst.org_structure_path IS NULL
    OR inst.org_structure_node_id IS NULL
  )
  AND (
    NULLIF(TRIM(COALESCE(trt.client_name, '')), '') IS NOT NULL
    OR trt.org_structure_path IS NOT NULL
    OR trt.org_structure_node_id IS NOT NULL
  );

-- 4) Fallback: copy from anchor task when template row is still empty.
UPDATE tasks inst
SET
  client_name = COALESCE(NULLIF(TRIM(inst.client_name), ''), NULLIF(TRIM(anchor.client_name), '')),
  client_entity_id = COALESCE(inst.client_entity_id, anchor.client_entity_id),
  org_structure_node_id = COALESCE(inst.org_structure_node_id, anchor.org_structure_node_id),
  org_structure_level_key = COALESCE(inst.org_structure_level_key, anchor.org_structure_level_key),
  org_structure_path = COALESCE(inst.org_structure_path, anchor.org_structure_path),
  updated_at = NOW()
FROM task_recurrence_templates trt
JOIN tasks anchor ON anchor.id = trt.task_id
WHERE inst.recurrence_template_id = trt.id
  AND (
    NULLIF(TRIM(COALESCE(inst.client_name, '')), '') IS NULL
    OR inst.org_structure_path IS NULL
    OR inst.org_structure_node_id IS NULL
  )
  AND (
    NULLIF(TRIM(COALESCE(anchor.client_name, '')), '') IS NOT NULL
    OR anchor.org_structure_path IS NOT NULL
    OR anchor.org_structure_node_id IS NOT NULL
  );
