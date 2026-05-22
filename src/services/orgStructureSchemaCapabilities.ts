import type { OrganizationStructureLevel } from './organizationStructureService';
import type { OrganizationStructureStage } from './organizationStructureStages';

type DbClient = {
  query: (text: string, params?: any[]) => Promise<any>;
};

export type OrgStructureSchemaCapabilities = {
  hasStagesTable: boolean;
  hasNodeStageId: boolean;
  hasNodeEntityField: boolean;
};

let cachedCapabilities: OrgStructureSchemaCapabilities | null = null;

function isMissingRelationError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '42P01'
  );
}

export async function getOrgStructureSchemaCapabilities(
  client: DbClient
): Promise<OrgStructureSchemaCapabilities> {
  if (cachedCapabilities) {
    return cachedCapabilities;
  }

  let hasStagesTable = false;
  try {
    await client.query('SELECT 1 FROM organization_structure_stages LIMIT 0');
    hasStagesTable = true;
  } catch (error) {
    if (!isMissingRelationError(error)) {
      throw error;
    }
  }

  const columnResult = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'organization_structure_nodes'
       AND column_name IN ('stage_id', 'entity_field')`
  );
  const columnNames = new Set(columnResult.rows.map((row: { column_name: string }) => row.column_name));

  cachedCapabilities = {
    hasStagesTable,
    hasNodeStageId: columnNames.has('stage_id'),
    hasNodeEntityField: columnNames.has('entity_field'),
  };

  return cachedCapabilities;
}

export function resetOrgStructureSchemaCapabilitiesCache(): void {
  cachedCapabilities = null;
}

/** Synthetic stages from levels when DB has no stages tables yet. */
export function buildLegacyStagesFromLevels(
  organizationId: string,
  levels: OrganizationStructureLevel[]
): OrganizationStructureStage[] {
  const rootStage: OrganizationStructureStage = {
    id: 'legacy-root-stage',
    organizationId,
    stageOrder: 1,
    stageLabel: 'Root',
    isActive: true,
    levelIds: levels.map((level) => level.id),
    levels: [...levels],
  };

  const otherStages = levels.map((level, index) => ({
    id: `legacy-stage-${level.id}`,
    organizationId,
    stageOrder: index + 2,
    stageLabel: level.levelLabel,
    isActive: level.isActive,
    levelIds: [level.id],
    levels: [level],
  }));

  return [rootStage, ...otherStages];
}
