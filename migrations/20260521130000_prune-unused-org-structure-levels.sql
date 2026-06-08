-- Remove preset catalog level rows that no org node references.
-- Fixes phantom sections (Business Unit, Entity, Region, etc.) when the chart only uses
-- Financial Unit, Location, Project, Manufacturing Unit, etc.
-- organization_structure_stage_levels rows cascade via ON DELETE CASCADE on level_id.

DELETE FROM organization_structure_levels l
WHERE NOT EXISTS (
  SELECT 1
  FROM organization_structure_nodes n
  WHERE n.organization_id = l.organization_id
    AND n.level_id = l.id
);
