import ExcelJS from 'exceljs';
import { PoolClient } from 'pg';
import {
  BULK_CREATE_LEVEL_FIELD_SCHEMA,
  getEntityTypeOptionsForSection,
  getOrgLevelDefinitionByHeader,
} from './organizationStructureCatalog';
import {
  createOrganizationStructureNodeWithClient,
  getOrganizationStructureTree,
  type OrganizationStructureLevel,
  type OrganizationStructureNode,
  type OrganizationStructureTree,
} from './organizationStructureService';
import { getAssignmentSectionsFromTree } from '../utils/orgStructureAssignmentUtils';
import {
  buildStructureSheetPlan,
  formatNodeDisplayLabel,
  getNodeEntityTypeFromMeta,
} from './orgStructureBulkTemplate';

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

export function getSectionStorageKey(level: OrganizationStructureLevel): string {
  return level.levelLabel.trim();
}

export function getActiveLevelsFromL2(
  levelsOrTree: OrganizationStructureLevel[] | OrganizationStructureTree
): OrganizationStructureLevel[] {
  if (!Array.isArray(levelsOrTree)) {
    if (levelsOrTree?.nodes?.length) {
      return getAssignmentSectionsFromTree(levelsOrTree);
    }
    const levels = levelsOrTree?.levels ?? levelsOrTree?.catalogLevels ?? [];
    return levels
      .filter((l) => l.levelNumber > 1 && l.isActive !== false)
      .sort((a, b) => a.levelNumber - b.levelNumber);
  }
  return levelsOrTree
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

/** Normalize Excel cell text for header matching and bulk parsing. */
export function normalizeBulkCellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object' && value !== null) {
    if ('result' in value && (value as { result?: unknown }).result != null && (value as { result?: unknown }).result !== '') {
      return normalizeBulkCellText((value as { result?: unknown }).result);
    }
    if ('text' in value) return String((value as { text?: string }).text ?? '').trim();
    if ('richText' in value && Array.isArray((value as { richText: { text: string }[] }).richText)) {
      return (value as { richText: { text: string }[] }).richText.map((t) => t.text).join('').trim();
    }
  }
  return String(value).trim();
}

/** 1-based column index per header label (reads row 1 via eachCell — reliable with Excel tables). */
export function buildBulkSheetHeaderColMap(sheet: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const h = normalizeBulkCellText(cell.value);
    if (h) map.set(h.toLowerCase(), col);
  });
  return map;
}

function colFromHeaderMap(headerMap: Map<string, number>, ...names: string[]): number {
  for (const name of names) {
    const col = headerMap.get(name.toLowerCase());
    if (col != null) return col;
  }
  return -1;
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

export function buildLevelColumnDefs(
  levelsOrTree: OrganizationStructureLevel[] | OrganizationStructureTree
): LevelColumnDef[] {
  return getActiveLevelsFromL2(levelsOrTree).map((level) => ({
    header: `ORG UNIT - ${level.levelLabel.trim()}`,
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
    const plainLabel = def.level.levelLabel.trim().toLowerCase();
    let colIndex = -1;
    for (let i = 1; i < (headers?.length ?? 0); i++) {
      const h = String(headers[i] ?? '')
        .trim()
        .toLowerCase();
      if (
        h === label ||
        h === plainLabel ||
        h === String(def.level.levelNumber) ||
        h === `org unit ${plainLabel}` ||
        h === `org unit - ${plainLabel}` ||
        h === `org unit: ${plainLabel}`
      ) {
        colIndex = i;
        break;
      }
    }
    return { ...def, colIndex };
  });
}

/** Resolve org node by UUID, exact display label (web dropdown), or plain name. */
export async function resolveOrgStructureNodeFromHint(
  client: PoolClient,
  organizationId: string,
  raw: string,
  nodes?: OrganizationStructureNode[]
): Promise<string | null> {
  if (!raw?.trim() || !organizationId) return null;
  const trimmed = raw.trim();
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (uuidRe.test(trimmed)) {
    const r = await client.query(
      `SELECT id FROM organization_structure_nodes WHERE organization_id = $1 AND id = $2::uuid LIMIT 1`,
      [organizationId, trimmed]
    );
    return r.rows.length > 0 ? r.rows[0].id : null;
  }

  if (nodes?.length) {
    for (const node of nodes) {
      const display = formatNodeDisplayLabel(node, getNodeEntityTypeFromMeta(node));
      if (display.toLowerCase() === trimmed.toLowerCase()) return node.id;
    }
    for (const node of nodes) {
      if (node.status === 'active' && node.name.toLowerCase() === trimmed.toLowerCase()) {
        return node.id;
      }
    }
    const displayLabelMatch = trimmed.match(/^(.+?)\s*\([^)]+\)\s*$/);
    if (displayLabelMatch) {
      const innerName = displayLabelMatch[1].trim().toLowerCase();
      for (const node of nodes) {
        if (node.status === 'active' && node.name.toLowerCase() === innerName) {
          return node.id;
        }
      }
    }
  }

  const r = await client.query(
    `SELECT id FROM organization_structure_nodes
     WHERE organization_id = $1 AND status = 'active' AND LOWER(TRIM(name)) = LOWER($2)
     ORDER BY level_number DESC LIMIT 1`,
    [organizationId, trimmed]
  );
  return r.rows.length > 0 ? r.rows[0].id : null;
}

function resolveLevelFromSection(
  sectionRaw: string,
  levels: OrganizationStructureLevel[]
): OrganizationStructureLevel | null {
  const trimmed = (sectionRaw || '').trim();
  if (!trimmed) return null;
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum >= 1) {
    return levels.find((l) => l.levelNumber === asNum) ?? null;
  }
  const matches = levels.filter(
    (l) => l.levelLabel.trim().toLowerCase() === trimmed.toLowerCase()
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return null;
  return null;
}

interface StructureBulkRow {
  rowNumber: number;
  sectionLabel: string;
  parentName: string;
  entityType: string;
  fieldValues: Record<string, string>;
  needsNewSection: boolean; // section not yet a level row — createLevel on insert
}

function deriveNameAndCodeFromFieldValues(
  fieldValues: Record<string, string>
): { name: string; code: string | null } {
  const fieldName = (fieldValues.name || '').trim();
  const fieldCode = (fieldValues.code || '').trim();
  return {
    name: fieldName.slice(0, 255),
    code: fieldCode ? fieldCode.slice(0, 100) : null,
  };
}

function nodeCacheKey(parentNodeId: string | null | undefined, name: string): string {
  return `${parentNodeId ?? 'root'}:${name.trim().toLowerCase()}`;
}

async function processBulkRowsInParentOrder(
  items: StructureBulkRow[],
  client: PoolClient,
  organizationId: string,
  actorUserId: string,
  tree: OrganizationStructureTree,
  levels: OrganizationStructureLevel[],
  sheetName: string,
  pushError: (err: { sheet?: string; row?: number; message: string }) => void
): Promise<number> {
  const nodes = [...(tree.nodes || [])];
  const nodeIdByKey = new Map<string, string>();
  for (const node of nodes) {
    nodeIdByKey.set(nodeCacheKey(node.parentNodeId, node.name), node.id);
  }

  let updated = 0;
  let pending = [...items];
  let guard = 0;

  while (pending.length > 0 && guard < pending.length * 8 + 10) {
    guard += 1;
    const nextPending: StructureBulkRow[] = [];

    for (const item of pending) {
      try {
        const { name, code } = deriveNameAndCodeFromFieldValues(item.fieldValues);
        let parentNodeId: string | null = null;

        if (item.parentName.trim()) {
          parentNodeId = await resolveOrgStructureNodeFromHint(
            client,
            organizationId,
            item.parentName,
            nodes
          );
          if (!parentNodeId) {
            const parentLower = item.parentName.trim().toLowerCase();
            for (const node of nodes) {
              if (node.status === 'active' && node.name.trim().toLowerCase() === parentLower) {
                parentNodeId = node.id;
                break;
              }
            }
          }
          if (!parentNodeId) {
            nextPending.push(item);
            continue;
          }
        } else {
          const rootExists = nodes.some((n) => !n.parentNodeId);
          if (rootExists) {
            pushError({
              sheet: sheetName,
              row: item.rowNumber,
              message: 'PARENT_NAME is required (root already exists). Use parent label from Organisation Structure values.',
            });
            continue;
          }
        }

        const level = resolveLevelFromSection(item.sectionLabel, levels);
        const catalogDef = getOrgLevelDefinitionByHeader(item.sectionLabel);

        const existing = level
          ? await client.query(
              `SELECT id, code, meta_json FROM organization_structure_nodes
               WHERE organization_id = $1 AND level_id = $2
                 AND ((parent_node_id IS NULL AND $3::uuid IS NULL) OR parent_node_id = $3::uuid)
                 AND LOWER(TRIM(name)) = LOWER($4)
               LIMIT 1`,
              [organizationId, level.id, parentNodeId, name]
            )
          : { rows: [] as { id: string }[] };

        const metaJson = JSON.stringify({
          entityType: item.entityType,
          fieldValues: item.fieldValues,
        });

        if (existing.rows.length > 0) {
          const nodeId = existing.rows[0].id;
          await client.query(
            `UPDATE organization_structure_nodes
             SET name = $1, code = $2, meta_json = $3::jsonb, updated_by = $4, updated_at = CURRENT_TIMESTAMP
             WHERE id = $5 AND organization_id = $6`,
            [name, code, metaJson, actorUserId, nodeId, organizationId]
          );
          updated += 1;
          continue;
        }

        const created = await createOrganizationStructureNodeWithClient(
          client,
          organizationId,
          actorUserId,
          {
            relation: parentNodeId ? 'child' : 'root',
            parentNodeId: parentNodeId || undefined,
            ...(level
              ? { targetLevelId: level.id }
              : {
                  targetSectionLabel: item.sectionLabel,
                  createLevelLabel: item.sectionLabel,
                  createLevelDefinitionSource: catalogDef ? 'preset' : 'custom',
                  createLevelPresetKey: catalogDef ? `L${catalogDef.levelNumber}` : null,
                  createLevelFieldSchema: BULK_CREATE_LEVEL_FIELD_SCHEMA,
                }),
            entityField: item.entityType,
            name,
            code: code || undefined,
            fieldValues: item.fieldValues,
            metaJson: { entityType: item.entityType },
          }
        );

        if (item.needsNewSection) {
          const refreshed = await loadOrganizationStructureLevels(client, organizationId);
          levels.length = 0;
          levels.push(...refreshed);
        }

        nodes.push(created);
        nodeIdByKey.set(nodeCacheKey(created.parentNodeId, created.name), created.id);
        updated += 1;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        pushError({ sheet: sheetName, row: item.rowNumber, message });
      }
    }

    if (nextPending.length === pending.length) {
      for (const item of nextPending) {
        pushError({
          sheet: sheetName,
          row: item.rowNumber,
          message: `Parent not found: ${item.parentName}. Add parent row above or check Organisation Structure values.`,
        });
      }
      break;
    }
    pending = nextPending;
  }

  return updated;
}

export async function parseOrganizationStructureSheet(
  sheet: ExcelJS.Worksheet,
  client: PoolClient,
  organizationId: string,
  actorUserId: string,
  pushError: (err: { sheet?: string; row?: number; message: string }) => void
): Promise<number> {
  if (!sheet || (sheet.rowCount ?? 0) < 2) return 0;

  const tree = await getOrganizationStructureTree(organizationId, {
    includeArchived: false,
    includeInactive: false,
  });
  const levels = [...(tree.catalogLevels ?? tree.levels)];
  if (levels.length === 0 && !tree.summary?.hasRootNode) {
    pushError({
      sheet: sheet.name,
      message: 'No organisation structure yet. You may upload a root row (SECTION + Name, blank PARENT_NAME) or create root on web first.',
    });
  }

  const plan = buildStructureSheetPlan(tree, levels);
  const headerMap = buildBulkSheetHeaderColMap(sheet);

  const sectionIdx = colFromHeaderMap(headerMap, 'section', 'level');
  const parentIdx = colFromHeaderMap(headerMap, 'parent name', 'parent_name');
  const entityTypeIdx = colFromHeaderMap(headerMap, 'field type', 'entity_type', 'entity type');
  let fieldNameIdx = colFromHeaderMap(headerMap, 'field name');
  if (fieldNameIdx < 0) fieldNameIdx = colFromHeaderMap(headerMap, 'registered name');
  if (fieldNameIdx < 0) fieldNameIdx = colFromHeaderMap(headerMap, 'name');
  const shortCodeIdx = colFromHeaderMap(headerMap, 'short code', 'code');

  const reservedHeaders = new Set([
    'section',
    'level',
    'parent name',
    'parent_name',
    'field type',
    'entity_type',
    'entity type',
    'field name',
    'short code',
    'display label',
    'name',
    'code',
  ]);

  const fieldColByKey = new Map<string, number>();
  if (fieldNameIdx >= 0) fieldColByKey.set('name', fieldNameIdx);
  if (shortCodeIdx >= 0) fieldColByKey.set('code', shortCodeIdx);

  headerMap.forEach((col, h) => {
    if (!h || reservedHeaders.has(h)) return;
    const key = plan.headerToFieldKey.get(h);
    if (key && !fieldColByKey.has(key)) fieldColByKey.set(key, col);
  });

  if (sectionIdx < 0) {
    pushError({ sheet: sheet.name, message: 'Missing required column: Section (or legacy SECTION / LEVEL)' });
    return 0;
  }
  if (!fieldColByKey.has('name')) {
    pushError({
      sheet: sheet.name,
      message: 'Missing required column: Field Name (or legacy Name / Registered Name)',
    });
    return 0;
  }

  const getCell = (row: ExcelJS.Row, idx: number): string => {
    if (idx < 0) return '';
    try {
      return normalizeBulkCellText(row.getCell(idx).value);
    } catch {
      return '';
    }
  };

  const maxRow = Math.min(sheet.rowCount ?? 0, 50001);
  const parsed: StructureBulkRow[] = [];

  for (let r = 2; r <= maxRow; r++) {
    const row = sheet.getRow(r);
    const sectionRaw = getCell(row, sectionIdx);
    const parentName = parentIdx >= 0 ? getCell(row, parentIdx) : '';
    const entityTypeRaw = entityTypeIdx >= 0 ? getCell(row, entityTypeIdx) : '';
    const fieldValues: Record<string, string> = {};
    for (const [key, col] of fieldColByKey) {
      const v = getCell(row, col);
      if (v) fieldValues[key] = v;
    }
    const { name } = deriveNameAndCodeFromFieldValues(fieldValues);
    if (!sectionRaw && !name) continue;
    if (!sectionRaw) {
      pushError({ sheet: sheet.name, row: r, message: 'SECTION is required' });
      continue;
    }
    if (!name) {
      pushError({ sheet: sheet.name, row: r, message: 'Name is required (same as web node form)' });
      continue;
    }

    const level = resolveLevelFromSection(sectionRaw, levels);
    const needsNewSection = !level;
    const entityType = entityTypeRaw || sectionRaw;
    const allowedTypes = getEntityTypeOptionsForSection(sectionRaw);
    if (entityTypeRaw && !allowedTypes.some((t) => t.toLowerCase() === entityTypeRaw.toLowerCase())) {
      pushError({
        sheet: sheet.name,
        row: r,
        message: `Invalid Field Type for section ${sectionRaw}. Examples: ${allowedTypes.slice(0, 5).join(', ')}…`,
      });
      continue;
    }

    parsed.push({
      rowNumber: r,
      sectionLabel: sectionRaw,
      parentName,
      entityType,
      fieldValues,
      needsNewSection,
    });
  }

  return processBulkRowsInParentOrder(
    parsed,
    client,
    organizationId,
    actorUserId,
    tree,
    levels,
    sheet.name,
    pushError
  );
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
