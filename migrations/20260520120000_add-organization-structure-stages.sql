-- Stage-based org structure: stages define UI order; each stage can include multiple levels.
-- Nodes pick level + entity field freely; parent-child is not limited to level N-1.

CREATE TABLE IF NOT EXISTS organization_structure_stages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    stage_order INTEGER NOT NULL CHECK (stage_order >= 1),
    stage_label VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (organization_id, stage_order)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_structure_stages_org_label
  ON organization_structure_stages (organization_id, LOWER(stage_label));

CREATE TABLE IF NOT EXISTS organization_structure_stage_levels (
    stage_id UUID NOT NULL REFERENCES organization_structure_stages(id) ON DELETE CASCADE,
    level_id UUID NOT NULL REFERENCES organization_structure_levels(id) ON DELETE CASCADE,
    PRIMARY KEY (stage_id, level_id)
);

CREATE INDEX IF NOT EXISTS idx_org_structure_stage_levels_level_id
  ON organization_structure_stage_levels(level_id);

ALTER TABLE organization_structure_nodes
  ADD COLUMN IF NOT EXISTS stage_id UUID REFERENCES organization_structure_stages(id) ON DELETE SET NULL;

ALTER TABLE organization_structure_nodes
  ADD COLUMN IF NOT EXISTS entity_field VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_org_structure_nodes_stage_id
  ON organization_structure_nodes(organization_id, stage_id);

-- Allow multiple level definitions per org (e.g. two Region-type levels in different stages).
ALTER TABLE organization_structure_levels
  DROP CONSTRAINT IF EXISTS organization_structure_levels_organization_id_level_number_key;

DROP INDEX IF EXISTS idx_org_structure_levels_org_label;
CREATE INDEX IF NOT EXISTS idx_org_structure_levels_org_label_lookup
  ON organization_structure_levels (organization_id, LOWER(level_label));

-- Backfill: one stage per existing level, then link nodes.
INSERT INTO organization_structure_stages (organization_id, stage_order, stage_label, is_active)
SELECT DISTINCT l.organization_id, 1, 'Root', TRUE
FROM organization_structure_levels l
WHERE NOT EXISTS (
  SELECT 1 FROM organization_structure_stages s
  WHERE s.organization_id = l.organization_id AND s.stage_order = 1
);

INSERT INTO organization_structure_stages (organization_id, stage_order, stage_label, is_active)
SELECT l.organization_id, l.level_number + 1, l.level_label, COALESCE(l.is_active, TRUE)
FROM organization_structure_levels l
WHERE l.level_number > 1
  AND NOT EXISTS (
    SELECT 1 FROM organization_structure_stages s
    WHERE s.organization_id = l.organization_id AND s.stage_order = l.level_number + 1
  );

INSERT INTO organization_structure_stage_levels (stage_id, level_id)
SELECT s.id, l.id
FROM organization_structure_levels l
JOIN organization_structure_stages s
  ON s.organization_id = l.organization_id
 AND (
   (s.stage_order = 1 AND l.level_number = 1)
   OR (s.stage_order = l.level_number + 1 AND l.level_number > 1)
 )
ON CONFLICT DO NOTHING;

-- Root stage can include common section levels (Entity, Region, …) when present.
INSERT INTO organization_structure_stage_levels (stage_id, level_id)
SELECT rs.id, l.id
FROM organization_structure_stages rs
JOIN organization_structure_levels l ON l.organization_id = rs.organization_id
WHERE rs.stage_order = 1
  AND LOWER(l.level_label) IN ('entity', 'region', 'group', 'company', 'location', 'business unit')
ON CONFLICT DO NOTHING;

UPDATE organization_structure_nodes n
SET stage_id = s.id,
    entity_field = COALESCE(
      n.entity_field,
      NULLIF(TRIM(n.meta_json->>'entityType'), '')
    )
FROM organization_structure_stages s
WHERE n.organization_id = s.organization_id
  AND n.stage_id IS NULL
  AND n.level_number = s.stage_order;
