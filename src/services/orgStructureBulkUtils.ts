import ExcelJS from 'exceljs';
import { PoolClient } from 'pg';
import {
  getOrganizationStructureTree,
  type OrganizationStructureLevel,
  type OrganizationStructureTree,
} from './organizationStructureService';

export const EMPLOYEE_ORG_NODE_BY_LEVEL_KEY = 'orgNodeByLevel';

export type OrgNodeByLevel = Record<string, string>;

/** Sheets from legacy templates — uploads containing these fail fast. */
export const DEPRECATED_BULK_SHEET_NAMES = [
  'cost centres',
  'cost centers',
  'branches',
  'depot',
  'depots',
  'warehouse',
  'warehouses',
  'client entity services',
] as const;

/** Legacy entity-list column headers that are no longer accepted. */
export const LEGACY_ENTITY_LIST_COLUMN_NAMES = [
  'cost_centre_name',
  'cost centre',
  'cost center',
  'cost_centre',
  'depot_name',
  'depot',
  'warehouse_name',
  'warehouse',
  'org unit name',
  'org node name',
] as const;

const ROOT_LEVEL_NUMBER = 1;

export function getSectionStorageKey(level: OrganizationStructureLevel): string {
  return level.levelLabel.trim();
}

export function getActiveLevelsFromL2(levels: OrganizationStructureLevel[]): OrganizationStructureLevel[] {
  return [...levels]
    .filter((l) => l.levelNumber > 1 && l.isActive !== false)
    .sort((a, b) => a.levelNumber - b.levelNumber);
}

export function lookupOrgNodeId(orgNodeByLevel: OrgNodeByLevel, level: OrganizationStructureLevel): string | undefined {
  const labelKey = getSectionStorageKey(level);
  return orgNodeByLevel[labelKey] || orgNodeByLevel[String(level.levelNumber)];
}

export function getDeepestSelectedNodeId(
  orgNodeByLevel: OrgNodeByLevel,
  levelsFromL2: OrganizationStructureLevel[]
): string | null {
  if (levelsFromL2.length === 0) return null;
  for (let i = levelsFromL2.length - 1; i >= 0; i -= 1) {
    const id = lookupOrgNodeId(orgNodeByLevel, levelsFromL2[i]);
    if (id) return id;
  }
  return null;
}

export function buildOrgFieldValuesPayload(orgNodeByLevel: OrgNodeByLevel): Record<string, unknown> | null {
  if (Object.keys(orgNodeByLevel).length === 0) return null;
  return { [EMPLOYEE_ORG_NODE_BY_LEVEL_KEY]: orgNodeByLevel };
}

export function findDeprecatedSheets(workbook: ExcelJS.Workbook): string[] {
  const found: string[] = [];
  for (const ws of workbook.worksheets) {
    const normalized = (ws.name || '').trim().toLowerCase();
    if (DEPRECATED_BULK_SHEET_NAMES.includes(normalized as (typeof DEPRECATED_BULK_SHEET_NAMES)[number])) {
      found.push(ws.name);
    }
  }
  return found;
}

export function findLegacyEntityListColumns(headers: unknown[]): string[] {
  const found: string[] = [];
  for (let i = 1; i < (headers?.length ?? 0); i++) {
    const h = String(headers[i] ?? '')
      .trim()
      .toLowerCase();
    if (!h) continue;
    if (LEGACY_ENTITY_LIST_COLUMN_NAMES.includes(h as (typeof LEGACY_ENTITY_LIST_COLUMN_NAMES)[number])) {
      found.push(String(headers[i]).trim());
    }
  }
  return found;
}

export function isReservedOrgAssignmentHeader(header: string): boolean {
  const h = header.trim().toLowerCase();
  const reserved = new Set([
    'name of the client',
    'name',
    'entity type',
    'entity_type',
    'status',
    'org structure node id',
    'org_structure_node_id',
    'org node id',
    'organization node id',
    'org unit id',
    'organization unit id',
    'pan',
    'reporting partner',
    'reporting_partner_mobile',
    'reporting_partner',
    'organization_name',
    'name of the employee',
    'mobile number',
    'mobile',
    'reporting to',
    'reporting_to_mobile',
    'primary org unit',
    'primary org node',
    'primary org node id',
    'primary org unit id',
    'org node',
    'org unit',
  ]);
  return reserved.has(h);
}

export async function loadOrganizationStructureLevels(
  client: PoolClient,
  organizationId: string
): Promise<OrganizationStructureLevel[]> {
  const res = await client.query(
    `SELECT id, organization_id, level_number, level_key, level_label, definition_source, preset_key,
            field_schema_json, is_system_required, is_active, created_by, updated_by, created_at, updated_at
     FROM organization_structure_levels
     WHERE organization_id = $1
     ORDER BY level_number`,
    [organizationId]
  );
  return res.rows.map((row: any) => ({
    id: row.id,
    organizationId: row.organization_id,
    levelNumber: Number(row.level_number),
    levelKey: row.level_key,
    levelLabel: row.level_label,
    definitionSource: row.definition_source,
    presetKey: row.preset_key,
    fieldSchemaJson: row.field_schema_json || [],
    isSystemRequired: row.is_system_required,
    isActive: row.is_active !== false,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function loadTreeForBulk(organizationId: string): Promise<OrganizationStructureTree> {
  return getOrganizationStructureTree(organizationId, {
    includeArchived: false,
    includeInactive: false,
  });
}

export type LevelColumnDef = { header: string; level: OrganizationStructureLevel; colIndex?: number };

export function buildLevelColumnDefs(levels: OrganizationStructureLevel[]): LevelColumnDef[] {
  return getActiveLevelsFromL2(levels).map((level) => ({
    header: level.levelLabel.trim(),
    level,
  }));
}

export function findLevelColumnIndices(
  headers: unknown[],
  levels: OrganizationStructureLevel[]
): LevelColumnDef[] {
  const defs = buildLevelColumnDefs(levels);
  return defs.map((def) => {
    const label = def.header.toLowerCase();
    let colIndex = -1;
    for (let i = 1; i < (headers?.length ?? 0); i++) {
      const h = String(headers[i] ?? '')
        .trim()
        .toLowerCase();
      if (h === label || h === String(def.level.levelNumber)) {
        colIndex = i;
        break;
      }
    }
    return { ...def, colIndex };
  });
}

export function addStructureReferenceSheet(
  workbook: ExcelJS.Workbook,
  tree: OrganizationStructureTree | null
): void {
  const sheet = workbook.addWorksheet('Structure Reference', {
    headerFooter: { firstHeader: 'OrgIt - Structure Reference (read-only guide)' },
  });
  sheet.columns = [
    { header: 'NODE_ID', key: 'node_id', width: 38 },
    { header: 'LEVEL', key: 'level', width: 18 },
    { header: 'NAME', key: 'name', width: 28 },
    { header: 'CODE', key: 'code', width: 16 },
    { header: 'FULL_PATH', key: 'full_path', width: 50 },
  ];
  sheet.getRow(1).font = { bold: true };
  if (!tree?.nodes?.length) {
    sheet.getRow(2).getCell(1).value =
      'No organisation structure nodes yet. Fill the Organisation Structure sheet first, then upload.';
    return;
  }
  const sorted = [...tree.nodes].sort(
    (a, b) => a.levelNumber - b.levelNumber || a.displayOrder - b.displayOrder || a.name.localeCompare(b.name)
  );
  sorted.forEach((node, idx) => {
    const row = sheet.getRow(idx + 2);
    row.getCell(1).value = node.id;
    row.getCell(2).value = node.levelLabel || String(node.levelNumber);
    row.getCell(3).value = node.name;
    row.getCell(4).value = node.code || '';
    row.getCell(5).value = node.pathDisplay || node.name;
  });
}

export function addOrganisationStructureDataSheet(
  workbook: ExcelJS.Workbook,
  tree: OrganizationStructureTree | null
): void {
  const sheet = workbook.addWorksheet('Organisation Structure', {
    headerFooter: { firstHeader: 'OrgIt Settings - Organisation Structure' },
  });
  sheet.columns = [
    { header: 'LEVEL', key: 'level', width: 20 },
    { header: 'PARENT_NAME', key: 'parent_name', width: 28 },
    { header: 'NAME', key: 'name', width: 28 },
    { header: 'CODE', key: 'code', width: 16 },
  ];
  sheet.getRow(1).font = { bold: true };
  if (!tree?.nodes?.length) {
    sheet.getRow(2).getCell(1).value = 'Group';
    sheet.getRow(2).getCell(2).value = '';
    sheet.getRow(2).getCell(3).value = '';
    sheet.getRow(2).getCell(4).value = '';
    return;
  }
  const sorted = [...tree.nodes].sort(
    (a, b) => a.levelNumber - b.levelNumber || a.displayOrder - b.displayOrder || a.name.localeCompare(b.name)
  );
  sorted.forEach((node, idx) => {
    const row = sheet.getRow(idx + 2);
    row.getCell(1).value = node.levelLabel || String(node.levelNumber);
    row.getCell(2).value = node.parentName || '';
    row.getCell(3).value = node.name;
    row.getCell(4).value = node.code || '';
  });
}

function resolveLevelFromRaw(
  raw: string,
  levels: OrganizationStructureLevel[]
): OrganizationStructureLevel | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum >= 1) {
    return levels.find((l) => l.levelNumber === asNum) ?? null;
  }
  return (
    levels.find((l) => l.levelLabel.trim().toLowerCase() === trimmed.toLowerCase()) ?? null
  );
}

export interface StructureBulkRow {
  rowNumber: number;
  level: OrganizationStructureLevel;
  parentName: string;
  name: string;
  code: string | null;
}

export async function parseOrganizationStructureSheet(
  sheet: ExcelJS.Worksheet,
  client: PoolClient,
  organizationId: string,
  actorUserId: string,
  pushError: (err: { sheet?: string; row?: number; message: string }) => void
): Promise<number> {
  if (!sheet || (sheet.rowCount ?? 0) < 2) return 0;

  const levels = await loadOrganizationStructureLevels(client, organizationId);
  if (levels.length === 0) {
    pushError({
      sheet: sheet.name,
      message: 'No organisation structure levels defined. Create the Group root in Organisation Structure settings first.',
    });
    return 0;
  }

  const headers = sheet.getRow(1).values as unknown[];
  const levelIdx = headers.findIndex(
    (h) => String(h ?? '').trim().toLowerCase() === 'level'
  );
  const parentIdx = headers.findIndex(
    (h) => String(h ?? '').trim().toLowerCase() === 'parent_name' || String(h ?? '').trim().toLowerCase() === 'parent name'
  );
  const nameIdx = headers.findIndex((h) => String(h ?? '').trim().toLowerCase() === 'name');
  const codeIdx = headers.findIndex((h) => String(h ?? '').trim().toLowerCase() === 'code');

  if (levelIdx < 0 || nameIdx < 0) {
    pushError({ sheet: sheet.name, message: 'Missing required columns: LEVEL and NAME' });
    return 0;
  }

  const getCell = (row: ExcelJS.Row, idx: number): string => {
    if (idx < 0) return '';
    try {
      const v = row.getCell(idx).value;
      if (v == null) return '';
      if (typeof v === 'string') return v.trim();
      if (typeof v === 'object' && v !== null && 'text' in v) return String((v as { text?: string }).text).trim();
      return String(v).trim();
    } catch {
      return '';
    }
  };

  const maxRow = Math.min(sheet.rowCount ?? 0, 50001);
  const parsed: StructureBulkRow[] = [];

  for (let r = 2; r <= maxRow; r++) {
    const row = sheet.getRow(r);
    const levelRaw = getCell(row, levelIdx);
    const name = getCell(row, nameIdx);
    const parentName = parentIdx >= 0 ? getCell(row, parentIdx) : '';
    const codeRaw = codeIdx >= 0 ? getCell(row, codeIdx) : '';
    if (!levelRaw && !name) continue;
    if (!levelRaw || !name) {
      pushError({ sheet: sheet.name, row: r, message: 'LEVEL and NAME are required' });
      continue;
    }
    const level = resolveLevelFromRaw(levelRaw, levels);
    if (!level) {
      pushError({ sheet: sheet.name, row: r, message: `Unknown level: ${levelRaw}` });
      continue;
    }
    if (level.levelNumber === ROOT_LEVEL_NUMBER && parentName) {
      pushError({ sheet: sheet.name, row: r, message: 'Group root row must have blank PARENT_NAME' });
      continue;
    }
    if (level.levelNumber > ROOT_LEVEL_NUMBER && !parentName) {
      pushError({ sheet: sheet.name, row: r, message: 'PARENT_NAME is required for non-Group levels' });
      continue;
    }
    parsed.push({
      rowNumber: r,
      level,
      parentName,
      name: name.slice(0, 255),
      code: codeRaw ? codeRaw.slice(0, 100) : null,
    });
  }

  parsed.sort((a, b) => a.level.levelNumber - b.level.levelNumber);

  let updated = 0;
  for (const item of parsed) {
    try {
      let parentNodeId: string | null = null;
      if (item.level.levelNumber > ROOT_LEVEL_NUMBER) {
        const parentLevelNumber = item.level.levelNumber - 1;
        const parentRes = await client.query(
          `SELECT id FROM organization_structure_nodes
           WHERE organization_id = $1
             AND level_number = $2
             AND status = 'active'
             AND LOWER(TRIM(name)) = LOWER($3)
           LIMIT 2`,
          [organizationId, parentLevelNumber, item.parentName]
        );
        if (parentRes.rows.length === 0) {
          pushError({
            sheet: sheet.name,
            row: item.rowNumber,
            message: `Parent not found: ${item.parentName} (level ${parentLevelNumber})`,
          });
          continue;
        }
        if (parentRes.rows.length > 1) {
          pushError({
            sheet: sheet.name,
            row: item.rowNumber,
            message: `Ambiguous parent name: ${item.parentName}`,
          });
          continue;
        }
        parentNodeId = parentRes.rows[0].id;
      }

      const existing = await client.query(
        `SELECT id, code FROM organization_structure_nodes
         WHERE organization_id = $1
           AND level_number = $2
           AND (
             (parent_node_id IS NULL AND $3::uuid IS NULL)
             OR parent_node_id = $3::uuid
           )
           AND LOWER(TRIM(name)) = LOWER($4)
         LIMIT 1`,
        [organizationId, item.level.levelNumber, parentNodeId, item.name]
      );

      if (existing.rows.length > 0) {
        const nodeId = existing.rows[0].id;
        if (item.code != null && item.code !== (existing.rows[0].code || '')) {
          await client.query(
            `UPDATE organization_structure_nodes
             SET code = $1, updated_by = $2, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3 AND organization_id = $4`,
            [item.code, actorUserId, nodeId, organizationId]
          );
        }
        updated += 1;
        continue;
      }

      const siblingOrder = await client.query(
        `SELECT COALESCE(MAX(display_order), -1) AS max_display_order
         FROM organization_structure_nodes
         WHERE organization_id = $1
           AND (
             (parent_node_id IS NULL AND $2::uuid IS NULL)
             OR parent_node_id = $2::uuid
           )
           AND level_number = $3`,
        [organizationId, parentNodeId, item.level.levelNumber]
      );
      const displayOrder = Number(siblingOrder.rows[0]?.max_display_order ?? -1) + 1;
      const metaJson = JSON.stringify({
        entityType: item.level.levelLabel,
        fieldValues: { name: item.name, ...(item.code ? { code: item.code } : {}) },
      });

      await client.query(
        `INSERT INTO organization_structure_nodes (
           id, organization_id, level_id, level_number, level_key, level_label,
           parent_node_id, name, code, description, display_order, status, meta_json,
           created_by, updated_by, created_at, updated_at
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, 'active', $10::jsonb,
           $11, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         )`,
        [
          organizationId,
          item.level.id,
          item.level.levelNumber,
          item.level.levelKey,
          item.level.levelLabel,
          parentNodeId,
          item.name,
          item.code,
          displayOrder,
          metaJson,
          actorUserId,
        ]
      );
      updated += 1;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      pushError({ sheet: sheet.name, row: item.rowNumber, message });
    }
  }

  return updated;
}

export async function parseOrgNodeByLevelFromRow(
  row: ExcelJS.Row,
  levelCols: LevelColumnDef[],
  resolveNode: (raw: string) => Promise<string | null>
): Promise<OrgNodeByLevel> {
  const out: OrgNodeByLevel = {};
  for (const def of levelCols) {
    if (def.colIndex == null || def.colIndex < 0) continue;
    const raw = (() => {
      try {
        const v = row.getCell(def.colIndex).value;
        if (v == null) return '';
        if (typeof v === 'string') return v.trim();
        if (typeof v === 'object' && v !== null && 'text' in v) {
          return String((v as { text?: string }).text).trim();
        }
        return String(v).trim();
      } catch {
        return '';
      }
    })();
    if (!raw) continue;
    const nodeId = await resolveNode(raw);
    if (nodeId) {
      out[getSectionStorageKey(def.level)] = nodeId;
    }
  }
  return out;
}
