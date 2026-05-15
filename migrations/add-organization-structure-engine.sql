CREATE TABLE IF NOT EXISTS organization_structure_levels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    level_number INTEGER NOT NULL CHECK (level_number >= 1),
    level_key VARCHAR(100) NOT NULL,
    level_label VARCHAR(255) NOT NULL,
    is_system_required BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (organization_id, level_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_org_structure_levels_org_key
  ON organization_structure_levels (organization_id, level_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_structure_levels_org_label
  ON organization_structure_levels (organization_id, LOWER(level_label));

CREATE TABLE IF NOT EXISTS organization_structure_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    level_id UUID NOT NULL REFERENCES organization_structure_levels(id) ON DELETE RESTRICT,
    level_number INTEGER NOT NULL CHECK (level_number >= 1),
    level_key VARCHAR(100) NOT NULL,
    level_label VARCHAR(255) NOT NULL,
    parent_node_id UUID REFERENCES organization_structure_nodes(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    code VARCHAR(255) NOT NULL,
    description TEXT,
    display_order INTEGER DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
    meta_json JSONB DEFAULT '{}'::jsonb,
    archived_by UUID REFERENCES users(id) ON DELETE SET NULL,
    archived_at TIMESTAMP,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_org_structure_nodes_org_id ON organization_structure_nodes(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_structure_nodes_parent_id ON organization_structure_nodes(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_org_structure_nodes_level_number ON organization_structure_nodes(organization_id, level_number);
CREATE INDEX IF NOT EXISTS idx_org_structure_nodes_status ON organization_structure_nodes(organization_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_structure_nodes_unique_code
  ON organization_structure_nodes (organization_id, LOWER(code));
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_structure_nodes_unique_name_per_parent
  ON organization_structure_nodes (organization_id, COALESCE(parent_node_id, '00000000-0000-0000-0000-000000000000'::uuid), LOWER(name));
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_structure_nodes_single_root
  ON organization_structure_nodes (organization_id)
  WHERE level_number = 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_organizations' AND column_name = 'primary_org_node_id'
  ) THEN
    ALTER TABLE user_organizations ADD COLUMN primary_org_node_id UUID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_organizations' AND column_name = 'secondary_org_node_ids'
  ) THEN
    ALTER TABLE user_organizations ADD COLUMN secondary_org_node_ids UUID[] DEFAULT ARRAY[]::UUID[];
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'user_organizations'
      AND constraint_name = 'fk_user_organizations_primary_org_node'
  ) THEN
    ALTER TABLE user_organizations
      ADD CONSTRAINT fk_user_organizations_primary_org_node
      FOREIGN KEY (primary_org_node_id) REFERENCES organization_structure_nodes(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'org_structure_node_id'
  ) THEN
    ALTER TABLE tasks ADD COLUMN org_structure_node_id UUID REFERENCES organization_structure_nodes(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'org_structure_level_key'
  ) THEN
    ALTER TABLE tasks ADD COLUMN org_structure_level_key VARCHAR(100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tasks' AND column_name = 'org_structure_path'
  ) THEN
    ALTER TABLE tasks ADD COLUMN org_structure_path JSONB;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_organizations_primary_org_node_id ON user_organizations(primary_org_node_id);
CREATE INDEX IF NOT EXISTS idx_tasks_org_structure_node_id ON tasks(org_structure_node_id);

CREATE TABLE IF NOT EXISTS organization_structure_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    entity_type VARCHAR(100) NOT NULL,
    entity_id UUID NOT NULL,
    action VARCHAR(100) NOT NULL,
    before_value JSONB,
    after_value JSONB,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_org_structure_audit_logs_org_id ON organization_structure_audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_structure_audit_logs_entity ON organization_structure_audit_logs(entity_type, entity_id);
