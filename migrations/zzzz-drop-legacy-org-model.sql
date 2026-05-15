DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'client_entities'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'client_entities' AND column_name = 'org_structure_node_id'
    ) THEN
      ALTER TABLE client_entities
        ADD COLUMN org_structure_node_id UUID REFERENCES organization_structure_nodes(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'client_entities' AND column_name = 'org_structure_path'
    ) THEN
      ALTER TABLE client_entities
        ADD COLUMN org_structure_path JSONB;
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_client_entities_org_structure_node_id
  ON client_entities(org_structure_node_id);

DROP INDEX IF EXISTS idx_client_entities_cost_centre_id;
DROP INDEX IF EXISTS idx_client_entities_depot_id;
DROP INDEX IF EXISTS idx_client_entities_warehouse_id;

ALTER TABLE IF EXISTS client_entities
  DROP COLUMN IF EXISTS cost_centre_id,
  DROP COLUMN IF EXISTS depot_id,
  DROP COLUMN IF EXISTS warehouse_id;

ALTER TABLE IF EXISTS user_organizations
  DROP COLUMN IF EXISTS department,
  DROP COLUMN IF EXISTS designation,
  DROP COLUMN IF EXISTS level;

ALTER TABLE IF EXISTS tasks
  DROP COLUMN IF EXISTS task_unit,
  DROP COLUMN IF EXISTS task_unit_name;

DROP TABLE IF EXISTS organization_structure_legacy_mappings;
DROP TABLE IF EXISTS departments;
DROP TABLE IF EXISTS designations;
DROP TABLE IF EXISTS cost_centres;
DROP TABLE IF EXISTS branches;
DROP TABLE IF EXISTS depots;
DROP TABLE IF EXISTS warehouses;
