-- Repair client_entities when migrations were baselined but DDL never ran.

ALTER TABLE client_entities
  ADD COLUMN IF NOT EXISTS entity_type VARCHAR(100);

ALTER TABLE client_entities
  ADD COLUMN IF NOT EXISTS org_structure_node_id UUID REFERENCES organization_structure_nodes(id) ON DELETE SET NULL;

ALTER TABLE client_entities
  ADD COLUMN IF NOT EXISTS org_structure_path JSONB;

ALTER TABLE client_entities
  ADD COLUMN IF NOT EXISTS pan VARCHAR(50);

ALTER TABLE client_entities
  ADD COLUMN IF NOT EXISTS reporting_partner_mobile VARCHAR(20);

ALTER TABLE client_entities
  ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'active';

ALTER TABLE client_entities
  ADD COLUMN IF NOT EXISTS org_field_values JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_client_entities_org_structure_node_id
  ON client_entities(org_structure_node_id);
