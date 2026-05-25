import {
  getOrganizationStructureTree,
  resolveNodeReference,
} from '../services/organizationStructureService';

export const EMPLOYEE_ORG_NODE_BY_LEVEL_KEY = 'orgNodeByLevel';

export function extractOrgNodeByLevel(raw: Record<string, unknown> | undefined): Record<string, string> {
  if (!raw) return {};
  const nested = raw[EMPLOYEE_ORG_NODE_BY_LEVEL_KEY];
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) {
      out[key.trim()] = value.trim();
    }
  }
  return out;
}

export function stripOrgNodeByLevel(raw: Record<string, unknown>): Record<string, unknown> {
  const next = { ...raw };
  delete next[EMPLOYEE_ORG_NODE_BY_LEVEL_KEY];
  return next;
}

function resolveLevelForKey(
  key: string,
  levelsBelowGroup: Array<{ levelNumber: number; levelLabel: string }>
): { levelNumber: number; levelLabel: string } | undefined {
  const byLabel = levelsBelowGroup.find((l) => l.levelLabel.toLowerCase() === key.toLowerCase());
  if (byLabel) return byLabel;

  const asNumber = Number(key);
  if (Number.isFinite(asNumber)) {
    return levelsBelowGroup.find((l) => l.levelNumber === asNumber);
  }
  return undefined;
}

export async function validateOrgNodeByLevelChain(
  organizationId: string,
  orgNodeByLevel: Record<string, string>
): Promise<void> {
  if (Object.keys(orgNodeByLevel).length === 0) return;

  const tree = await getOrganizationStructureTree(organizationId, {
    includeArchived: false,
    includeInactive: false,
  });

  const rootId = tree.rootNode?.id;
  if (!rootId) {
    throw new Error('Organisation group (root) is not configured');
  }

  const levelsBelowGroup = tree.levels
    .filter((l) => l.levelNumber > 1 && l.isActive !== false)
    .sort((a, b) => a.levelNumber - b.levelNumber);

  for (const [key, nodeId] of Object.entries(orgNodeByLevel)) {
    const level = resolveLevelForKey(key, levelsBelowGroup);
    if (!level) {
      throw new Error(`Unknown organisation section "${key}"`);
    }

    await resolveNodeReference(organizationId, nodeId, { activeOnly: false });
    const node = tree.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`Organisation node for "${level.levelLabel}" not found`);
    }
    if ((node.levelLabel || '').trim().toLowerCase() !== level.levelLabel.trim().toLowerCase()) {
      throw new Error(`Selected node does not belong to section "${level.levelLabel}"`);
    }

    const pathIds = node.pathIds || [];
    if (!pathIds.includes(rootId)) {
      throw new Error(`"${level.levelLabel}" selection must be under the organisation group`);
    }
  }
}

function resolveDeepestFromSelectedNodeIds(
  nodes: Array<{ id: string; stageOrder?: number | null; levelNumber?: number | null }>,
  orgNodeByLevel: Record<string, string>
): string | null {
  const ids = [...new Set(Object.values(orgNodeByLevel).map((id) => id?.trim()).filter(Boolean))] as string[];
  if (ids.length === 0) return null;

  let bestId: string | null = null;
  let bestOrder = -1;
  for (const id of ids) {
    const node = nodes.find((n) => n.id === id);
    const order = node?.stageOrder ?? node?.levelNumber ?? 0;
    if (order >= bestOrder) {
      bestOrder = order;
      bestId = id;
    }
  }
  return bestId;
}

export function resolvePrimaryFromOrgNodeByLevel(
  orgNodeByLevel: Record<string, string>,
  levelsBelowGroup?: Array<{ levelNumber: number; levelLabel: string }>,
  treeNodes?: Array<{ id: string; stageOrder?: number | null; levelNumber?: number | null }>
): string | null {
  if (Object.keys(orgNodeByLevel).length === 0) return null;

  if (levelsBelowGroup && levelsBelowGroup.length > 0) {
    const sorted = [...levelsBelowGroup].sort((a, b) => a.levelNumber - b.levelNumber);
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const level = sorted[i];
      const nodeId =
        orgNodeByLevel[level.levelLabel] || orgNodeByLevel[String(level.levelNumber)];
      if (nodeId) return nodeId;
    }
  }

  const numericKeys = Object.keys(orgNodeByLevel)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 1)
    .sort((a, b) => a - b);
  if (numericKeys.length > 0) {
    return orgNodeByLevel[String(numericKeys[numericKeys.length - 1])] || null;
  }

  if (treeNodes?.length) {
    return resolveDeepestFromSelectedNodeIds(treeNodes, orgNodeByLevel);
  }

  return Object.values(orgNodeByLevel).find((id) => Boolean(id?.trim())) || null;
}
