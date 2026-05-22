-- Root = single node with no parent (any level/section), not forced to level_number = 1.
DROP INDEX IF EXISTS idx_org_structure_nodes_single_root;
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_structure_nodes_single_root
  ON organization_structure_nodes (organization_id)
  WHERE parent_node_id IS NULL;
