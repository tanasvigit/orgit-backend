import type {
  OrganizationStructureLevel,
  OrganizationStructureNode,
  OrganizationStructureTree,
} from '../services/organizationStructureService';

/** Active org nodes under the organisation root (excludes the root node itself). */
export function getActiveNodesUnderRoot(
  tree: Pick<OrganizationStructureTree, 'nodes' | 'rootNode'> | null | undefined
): OrganizationStructureNode[] {
  const rootNodeId = tree?.rootNode?.id;
  if (!tree || !rootNodeId) return [];
  return (tree.nodes ?? []).filter((n) => {
    if (!n?.id || n.status === 'archived') return false;
    if (n.id === rootNodeId || !n.parentNodeId) return false;
    const pathIds = n.pathIds || [];
    return pathIds.includes(rootNodeId);
  });
}

/**
 * Section definitions that appear on the org chart (have at least one node),
 * not the full preset catalog in organization_structure_levels.
 */
export function getAssignmentSectionsFromTree(
  tree: Pick<OrganizationStructureTree, 'levels' | 'nodes' | 'rootNode'> | null | undefined,
  currentValue?: Record<string, string>
): OrganizationStructureLevel[] {
  const rootNodeId = tree?.rootNode?.id;
  if (!tree || !rootNodeId) return [];

  const levels = tree.levels ?? [];
  const levelByLabel = new Map(levels.map((l) => [l.levelLabel.trim().toLowerCase(), l]));
  const levelById = new Map(levels.map((l) => [l.id, l]));

  const sectionByKey = new Map<string, { level: OrganizationStructureLevel; sortKey: number }>();

  const addSection = (node: OrganizationStructureNode) => {
    const label = (node.levelLabel || '').trim();
    if (!label) return;
    const key = label.toLowerCase();
    const matched =
      levelById.get(node.levelId) ||
      levelByLabel.get(key) ||
      ({
        id: node.levelId,
        organizationId: node.organizationId,
        levelNumber: node.levelNumber,
        levelKey: node.levelKey,
        levelLabel: label,
        definitionSource: 'custom' as const,
        fieldSchemaJson: [],
        isSystemRequired: false,
        isActive: true,
      } as OrganizationStructureLevel);
    const sortKey = node.stageOrder ?? node.levelNumber ?? 999;
    const prev = sectionByKey.get(key);
    if (!prev || sortKey < prev.sortKey) {
      sectionByKey.set(key, { level: matched, sortKey });
    }
  };

  if (tree.rootNode && tree.rootNode.levelNumber > 0) {
    addSection(tree.rootNode);
  }

  for (const node of getActiveNodesUnderRoot(tree)) {
    addSection(node);
  }

  if (currentValue) {
    for (const nodeId of Object.values(currentValue)) {
      if (!nodeId?.trim()) continue;
      const node = tree.nodes.find((n) => n.id === nodeId);
      if (node) addSection(node);
    }
  }

  return Array.from(sectionByKey.values())
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((entry) => entry.level);
}

/** Level rows referenced by at least one org node (catalog entries with no nodes are excluded). */
export function filterLevelsUsedOnTree(
  levels: OrganizationStructureLevel[],
  nodes: OrganizationStructureNode[]
): OrganizationStructureLevel[] {
  const usedLevelIds = new Set(
    nodes.filter((n) => n.status !== 'archived').map((n) => n.levelId).filter(Boolean)
  );
  if (usedLevelIds.size === 0) {
    return levels.filter((l) => l.levelNumber === 1 && l.isActive !== false);
  }
  return levels.filter((l) => usedLevelIds.has(l.id));
}
