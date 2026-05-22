import type { OrganizationStructureLevel } from './organizationStructureService';
import {
  buildLegacyStagesFromLevels,
  getOrgStructureSchemaCapabilities,
} from './orgStructureSchemaCapabilities';

type DbClient = {
  query: (text: string, params?: any[]) => Promise<any>;
};

export interface OrganizationStructureStage {
  id: string;
  organizationId: string;
  stageOrder: number;
  stageLabel: string;
  isActive: boolean;
  levelIds: string[];
  levels: OrganizationStructureLevel[];
}

function mapStageRow(row: any, levels: OrganizationStructureLevel[]): OrganizationStructureStage {
  return {
    id: row.id,
    organizationId: row.organization_id,
    stageOrder: Number(row.stage_order),
    stageLabel: row.stage_label,
    isActive: Boolean(row.is_active),
    levelIds: levels.map((level) => level.id),
    levels,
  };
}

export async function getStagesInternal(client: DbClient, organizationId: string): Promise<OrganizationStructureStage[]> {
  const capabilities = await getOrgStructureSchemaCapabilities(client);
  if (!capabilities.hasStagesTable) {
    return [];
  }

  const stagesResult = await client.query(
    `SELECT *
     FROM organization_structure_stages
     WHERE organization_id = $1
     ORDER BY stage_order ASC`,
    [organizationId]
  );

  if (stagesResult.rows.length === 0) {
    return [];
  }

  const linksResult = await client.query(
    `SELECT sl.stage_id, l.*
     FROM organization_structure_stage_levels sl
     JOIN organization_structure_levels l ON l.id = sl.level_id
     WHERE l.organization_id = $1
     ORDER BY l.level_number ASC, l.level_label ASC`,
    [organizationId]
  );

  const levelsByStage = new Map<string, OrganizationStructureLevel[]>();
  for (const row of linksResult.rows) {
    const stageId = row.stage_id;
    const list = levelsByStage.get(stageId) || [];
    list.push({
      id: row.id,
      organizationId: row.organization_id,
      levelNumber: Number(row.level_number),
      levelKey: row.level_key,
      levelLabel: row.level_label,
      definitionSource: row.definition_source === 'preset' ? 'preset' : 'custom',
      presetKey: row.preset_key ?? null,
      fieldSchemaJson: row.field_schema_json || [],
      isSystemRequired: Boolean(row.is_system_required),
      isActive: Boolean(row.is_active),
      createdBy: row.created_by ?? null,
      updatedBy: row.updated_by ?? null,
      createdAt: row.created_at?.toISOString?.() ?? row.created_at,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    });
    levelsByStage.set(stageId, list);
  }

  return stagesResult.rows.map((row: any) => mapStageRow(row, levelsByStage.get(row.id) || []));
}

export function stageLabelForOrder(stageOrder: number): string {
  return stageOrder === 1 ? 'Root' : `Stage ${stageOrder}`;
}

/** Stage column index from parent/child/sibling — not from user-selected stage. */
export function resolveStageOrderForNodeCreate(
  relation: 'root' | 'child' | 'sibling',
  parentNode: { stageOrder?: number | null } | null,
  referenceNode: { stageOrder?: number | null } | null
): number {
  if (relation === 'root') {
    return 1;
  }
  if (relation === 'sibling') {
    return referenceNode?.stageOrder ?? parentNode?.stageOrder ?? 1;
  }
  const parentOrder = parentNode?.stageOrder ?? 1;
  return parentOrder + 1;
}

export async function ensureStageAtOrder(
  client: DbClient,
  organizationId: string,
  stageOrder: number
): Promise<string | null> {
  const capabilities = await getOrgStructureSchemaCapabilities(client);
  if (!capabilities.hasStagesTable || stageOrder < 1) {
    return null;
  }

  const existing = await client.query(
    `SELECT id
     FROM organization_structure_stages
     WHERE organization_id = $1
       AND stage_order = $2
     LIMIT 1`,
    [organizationId, stageOrder]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id as string;
  }

  const insert = await client.query(
    `INSERT INTO organization_structure_stages (
       id, organization_id, stage_order, stage_label, is_active, created_at, updated_at
     ) VALUES (
       gen_random_uuid(), $1, $2, $3, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     )
     RETURNING id`,
    [organizationId, stageOrder, stageLabelForOrder(stageOrder)]
  );
  return (insert.rows[0]?.id as string) ?? null;
}

export async function ensureStagesForOrganization(
  client: DbClient,
  organizationId: string,
  levels: OrganizationStructureLevel[]
): Promise<OrganizationStructureStage[]> {
  const capabilities = await getOrgStructureSchemaCapabilities(client);
  if (!capabilities.hasStagesTable) {
    return buildLegacyStagesFromLevels(organizationId, levels);
  }

  const existing = await getStagesInternal(client, organizationId);
  if (existing.length > 0) {
    return existing;
  }

  if (levels.length === 0) {
    return [];
  }

  const rootStageResult = await client.query(
    `INSERT INTO organization_structure_stages (
       id, organization_id, stage_order, stage_label, is_active, created_at, updated_at
     ) VALUES (
       gen_random_uuid(), $1, 1, 'Root', TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     )
     RETURNING *`,
    [organizationId]
  );
  const rootStageId = rootStageResult.rows[0]?.id as string;
  if (rootStageId) {
    for (const level of levels) {
      await client.query(
        `INSERT INTO organization_structure_stage_levels (stage_id, level_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [rootStageId, level.id]
      );
    }
  }

  // Only seed the root stage. Additional stage columns are created when the user
  // adds nodes (or picks a stage in the UI) — not from every level definition row.
  return getStagesInternal(client, organizationId);
}

export async function resolveStageForLevel(
  client: DbClient,
  organizationId: string,
  levelId: string,
  preferredStageId?: string | null
): Promise<OrganizationStructureStage | null> {
  const stages = await getStagesInternal(client, organizationId);
  if (stages.length === 0) {
    return null;
  }

  if (preferredStageId) {
    const preferred = stages.find((stage) => stage.id === preferredStageId);
    if (!preferred) {
      throw new Error('Stage not found');
    }
    if (!preferred.levelIds.includes(levelId)) {
      await linkLevelToStage(client, organizationId, preferredStageId, levelId);
      return {
        ...preferred,
        levelIds: [...preferred.levelIds, levelId],
        levels: preferred.levels,
      };
    }
    return preferred;
  }

  return stages.find((stage) => stage.levelIds.includes(levelId)) || null;
}

export async function assertLevelAllowedInStage(
  client: DbClient,
  organizationId: string,
  levelId: string,
  stageId?: string | null
): Promise<void> {
  const stages = await getStagesInternal(client, organizationId);
  if (stages.length === 0) {
    return;
  }

  if (!stageId) {
    const hasStage = stages.some((stage) => stage.levelIds.includes(levelId));
    if (!hasStage) {
      throw new Error('Chosen level is not assigned to any stage');
    }
    return;
  }

  const stage = stages.find((item) => item.id === stageId);
  if (!stage) {
    throw new Error('Stage not found');
  }
  if (!stage.levelIds.includes(levelId)) {
    throw new Error('Chosen level is not allowed in the selected stage');
  }
}

export async function linkLevelToStage(
  client: DbClient,
  organizationId: string,
  stageId: string,
  levelId: string
): Promise<void> {
  const capabilities = await getOrgStructureSchemaCapabilities(client);
  if (!capabilities.hasStagesTable || stageId.startsWith('legacy-')) {
    return;
  }

  const stageCheck = await client.query(
    `SELECT id FROM organization_structure_stages WHERE id = $1 AND organization_id = $2 LIMIT 1`,
    [stageId, organizationId]
  );
  if (stageCheck.rows.length === 0) {
    throw new Error('Stage not found');
  }

  const levelCheck = await client.query(
    `SELECT id FROM organization_structure_levels WHERE id = $1 AND organization_id = $2 LIMIT 1`,
    [levelId, organizationId]
  );
  if (levelCheck.rows.length === 0) {
    throw new Error('Level not found');
  }

  await client.query(
    `INSERT INTO organization_structure_stage_levels (stage_id, level_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [stageId, levelId]
  );
}
