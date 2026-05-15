ALTER TABLE organization_structure_levels
  ADD COLUMN IF NOT EXISTS definition_source VARCHAR(20) NOT NULL DEFAULT 'custom';

ALTER TABLE organization_structure_levels
  ADD COLUMN IF NOT EXISTS preset_key VARCHAR(100);

ALTER TABLE organization_structure_levels
  ADD COLUMN IF NOT EXISTS field_schema_json JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.constraint_column_usage ccu
    JOIN information_schema.table_constraints tc
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema = ccu.table_schema
    WHERE tc.table_name = 'organization_structure_levels'
      AND tc.constraint_type = 'CHECK'
      AND ccu.column_name = 'definition_source'
      AND tc.constraint_name = 'organization_structure_levels_definition_source_check'
  ) THEN
    ALTER TABLE organization_structure_levels
      ADD CONSTRAINT organization_structure_levels_definition_source_check
      CHECK (definition_source IN ('custom', 'preset'));
  END IF;
END $$;

ALTER TABLE organization_structure_nodes
  ALTER COLUMN code DROP NOT NULL;
