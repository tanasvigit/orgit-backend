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
      out[key] = value.trim();
    }
  }
  return out;
}

export function stripOrgNodeByLevel(raw: Record<string, unknown>): Record<string, unknown> {
  const next = { ...raw };
  delete next[EMPLOYEE_ORG_NODE_BY_LEVEL_KEY];
  return next;
}

export async function validateOrgNodeByLevelChain(
  organizationId: string,
  orgNodeByLevel: Record<string, string>
): Promise<void> {
  const levelKeys = Object.keys(orgNodeByLevel)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 1)
    .sort((a, b) => a - b);

  if (levelKeys.length === 0) return;

  const tree = await getOrganizationStructureTree(organizationId, {
    includeArchived: false,
    includeInactive: false,
  });

  let expectedParentId = tree.rootNode?.id || null;

  for (const levelNumber of levelKeys) {
    const nodeId = orgNodeByLevel[String(levelNumber)];
    await resolveNodeReference(organizationId, nodeId, { activeOnly: false });
    const node = tree.nodes.find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`Organisation node at level ${levelNumber} not found`);
    }
    if (node.levelNumber !== levelNumber) {
      throw new Error(`Selected node does not belong to level ${levelNumber}`);
    }
    if (levelNumber === 2) {
      if (expectedParentId && node.parentNodeId !== expectedParentId) {
        throw new Error('Invalid organisation (level 2) selection');
      }
    } else if (node.parentNodeId !== expectedParentId) {
      throw new Error(`Invalid selection for level ${levelNumber}`);
    }
    expectedParentId = node.id;
  }
}

export function resolvePrimaryFromOrgNodeByLevel(orgNodeByLevel: Record<string, string>): string | null {
  const levelKeys = Object.keys(orgNodeByLevel)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 1)
    .sort((a, b) => a - b);
  if (levelKeys.length === 0) return null;
  return orgNodeByLevel[String(levelKeys[levelKeys.length - 1])] || null;
}
