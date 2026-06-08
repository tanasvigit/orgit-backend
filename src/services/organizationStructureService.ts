import { getClient, query } from '../config/database';
import {
  getCustomFieldSchemaFromMeta,
  mergeFieldSchemasByKey,
  ORG_STRUCTURE_EXTENDED_FIELD_CATALOG,
} from './organizationStructureExtendedFieldCatalog';
import {
  getOrgStructureSchemaCapabilities,
} from './orgStructureSchemaCapabilities';
import {
  ensureStageAtOrder,
  ensureStagesForOrganization,
  getStagesInternal,
  linkLevelToStage,
  resolveStageOrderForNodeCreate,
  type OrganizationStructureStage,
} from './organizationStructureStages';
import { filterLevelsUsedOnTree } from '../utils/orgStructureAssignmentUtils';

export type { OrganizationStructureStage } from './organizationStructureStages';

type DbClient = {
  query: (text: string, params?: any[]) => Promise<any>;
  release?: () => void;
};

export type OrganizationStructureNodeStatus = 'active' | 'inactive' | 'archived';
export type OrganizationStructureDefinitionSource = 'custom' | 'preset';
export type OrganizationStructureFieldType = 'text' | 'textarea' | 'number' | 'date' | 'select' | 'pincode';

export interface OrganizationStructureFieldSchemaField {
  id: string;
  key: string;
  label: string;
  type: OrganizationStructureFieldType;
  required: boolean;
  options?: string[];
  placeholder?: string | null;
}

export interface OrganizationStructureLevel {
  id: string;
  organizationId: string;
  levelNumber: number;
  levelKey: string;
  levelLabel: string;
  definitionSource: OrganizationStructureDefinitionSource;
  presetKey?: string | null;
  fieldSchemaJson: OrganizationStructureFieldSchemaField[];
  isSystemRequired: boolean;
  isActive: boolean;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrganizationStructureNode {
  id: string;
  organizationId: string;
  stageId?: string | null;
  stageOrder?: number | null;
  stageLabel?: string | null;
  levelId: string;
  levelNumber: number;
  levelKey: string;
  levelLabel: string;
  entityField?: string | null;
  parentNodeId?: string | null;
  parentName?: string | null;
  name: string;
  code?: string | null;
  description?: string | null;
  displayOrder: number;
  status: OrganizationStructureNodeStatus;
  isActive: boolean;
  metaJson?: Record<string, unknown>;
  fieldValues?: Record<string, unknown>;
  createdBy?: string | null;
  updatedBy?: string | null;
  archivedBy?: string | null;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  path: Array<{
    id: string;
    name: string;
    code?: string | null;
    levelNumber: number;
    levelKey: string;
    levelLabel: string;
    status: OrganizationStructureNodeStatus;
  }>;
  pathDisplay: string;
  pathCodes: Array<string | null | undefined>;
  pathIds: string[];
  hasChildren: boolean;
  childrenCount: number;
}

export interface OrganizationStructureTree {
  stages: OrganizationStructureStage[];
  /** Levels referenced by at least one org node (not the full preset catalog). */
  levels: OrganizationStructureLevel[];
  /** Full level catalog from DB — for org-definition admin only. */
  catalogLevels?: OrganizationStructureLevel[];
  nodes: OrganizationStructureNode[];
  rootNode: OrganizationStructureNode | null;
  summary: {
    totalStages: number;
    totalLevels: number;
    catalogLevelCount?: number;
    totalNodes: number;
    activeNodes: number;
    archivedNodes: number;
    hasRootNode: boolean;
  };
}

export interface CreateOrganizationStructureNodeInput {
  relation: 'root' | 'child' | 'sibling';
  referenceNodeId?: string;
  /** When set, node attaches under this parent (loose coupling — any ancestor, not only reference). */
  parentNodeId?: string;
  targetLevelId?: string;
  stageId?: string;
  targetLevelNumber?: number;
  targetSectionLabel?: string;
  entityField?: string;
  name?: string;
  code?: string | null;
  description?: string;
  status?: OrganizationStructureNodeStatus;
  metaJson?: Record<string, unknown>;
  createLevelLabel?: string;
  createLevelDefinitionSource?: OrganizationStructureDefinitionSource;
  createLevelPresetKey?: string | null;
  createLevelFieldSchema?: OrganizationStructureFieldSchemaField[];
  fieldValues?: Record<string, unknown>;
}

export interface UpdateOrganizationStructureNodeInput {
  name?: string;
  code?: string | null;
  description?: string | null;
  status?: OrganizationStructureNodeStatus;
  metaJson?: Record<string, unknown>;
  fieldValues?: Record<string, unknown>;
}

export interface UpdateOrganizationStructureLevelInput {
  levelLabel?: string;
  definitionSource?: OrganizationStructureDefinitionSource;
  presetKey?: string | null;
  fieldSchemaJson?: OrganizationStructureFieldSchemaField[];
  isActive?: boolean;
}

const ROOT_LEVEL_NUMBER = 1;
const MAX_DEFINED_LEVEL = 11;

const NODE_STATUSES: OrganizationStructureNodeStatus[] = ['active', 'inactive', 'archived'];
const DEFINITION_SOURCES: OrganizationStructureDefinitionSource[] = ['custom', 'preset'];
const FIELD_TYPES: OrganizationStructureFieldType[] = ['text', 'textarea', 'number', 'date', 'select', 'pincode'];

const DEFAULT_LEVEL_FIELD_SCHEMA: OrganizationStructureFieldSchemaField[] = [
  {
    id: 'name',
    key: 'name',
    label: 'Name',
    type: 'text',
    required: true,
  },
  {
    id: 'code',
    key: 'code',
    label: 'Code',
    type: 'text',
    required: false,
  },
];

function slugifyLevelKey(label: string): string {
  const base = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return base || 'level';
}

function normalizeStatus(status: unknown, fallback: OrganizationStructureNodeStatus = 'active'): OrganizationStructureNodeStatus {
  const value = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (NODE_STATUSES.includes(value as OrganizationStructureNodeStatus)) {
    return value as OrganizationStructureNodeStatus;
  }

  return fallback;
}

function normalizeDefinitionSource(
  source: unknown,
  fallback: OrganizationStructureDefinitionSource = 'custom'
): OrganizationStructureDefinitionSource {
  const value = typeof source === 'string' ? source.trim().toLowerCase() : '';
  if (DEFINITION_SOURCES.includes(value as OrganizationStructureDefinitionSource)) {
    return value as OrganizationStructureDefinitionSource;
  }

  return fallback;
}

function getDefaultLevelFieldSchema(): OrganizationStructureFieldSchemaField[] {
  return DEFAULT_LEVEL_FIELD_SCHEMA.map((field) => ({ ...field }));
}

function normalizeFieldSchema(
  schema: unknown,
  options?: {
    fallbackToDefault?: boolean;
  }
): OrganizationStructureFieldSchemaField[] {
  if (!Array.isArray(schema)) {
    return options?.fallbackToDefault ? getDefaultLevelFieldSchema() : [];
  }

  const normalizedFields: OrganizationStructureFieldSchemaField[] = [];
  const usedKeys = new Set<string>();

  schema.forEach((field, index) => {
    if (!field || typeof field !== 'object') {
      return;
    }

    const candidate = field as Record<string, unknown>;
    const label = String(candidate.label || '').trim();
    const rawKey = String(candidate.key || label || `field_${index + 1}`).trim();
    const key = slugifyLevelKey(rawKey);
    if (!key || usedKeys.has(key)) {
      return;
    }

    const rawType = String(candidate.type || 'text').trim().toLowerCase();
    const type = FIELD_TYPES.includes(rawType as OrganizationStructureFieldType)
      ? (rawType as OrganizationStructureFieldType)
      : 'text';

    const optionsList =
      Array.isArray(candidate.options) && type === 'select'
        ? candidate.options
            .map((option) => String(option || '').trim())
            .filter((option) => !!option)
        : undefined;

    normalizedFields.push({
      id: String(candidate.id || key).trim() || key,
      key,
      label: label || rawKey || key,
      type,
      required: Boolean(candidate.required),
      options: optionsList && optionsList.length > 0 ? optionsList : undefined,
      placeholder:
        typeof candidate.placeholder === 'string' && candidate.placeholder.trim()
          ? candidate.placeholder.trim()
          : null,
    });
    usedKeys.add(key);
  });

  if (normalizedFields.length === 0 && options?.fallbackToDefault) {
    return getDefaultLevelFieldSchema();
  }

  return normalizedFields;
}

function validateAndNormalizeFieldSchema(schema: unknown): OrganizationStructureFieldSchemaField[] {
  const normalizedFields = normalizeFieldSchema(schema);
  if (normalizedFields.length === 0) {
    throw new Error('At least one field is required for the entity section');
  }

  const nameField = normalizedFields.find((field) => field.key === 'name');
  if (!nameField) {
    throw new Error('Each entity section must define a "name" field');
  }

  if (!nameField.required) {
    throw new Error('The "name" field must be required');
  }

  for (const field of normalizedFields) {
    if (field.type === 'select' && (!field.options || field.options.length === 0)) {
      throw new Error(`Field "${field.label}" must define options for select type`);
    }
  }

  return normalizedFields;
}

function getFieldValuesFromMetaJson(metaJson?: Record<string, unknown> | null): Record<string, unknown> {
  if (!metaJson || typeof metaJson !== 'object') {
    return {};
  }

  const fieldValues = (metaJson as Record<string, unknown>).fieldValues;
  if (!fieldValues || typeof fieldValues !== 'object' || Array.isArray(fieldValues)) {
    return {};
  }

  return { ...(fieldValues as Record<string, unknown>) };
}

function buildNodeMetaJson(
  existingMetaJson: Record<string, unknown> | undefined,
  levelLabel: string,
  fieldValues: Record<string, unknown>,
  options?: { customFieldSchema?: OrganizationStructureFieldSchemaField[] }
): Record<string, unknown> {
  const existing = existingMetaJson || {};
  const entityType =
    typeof existing.entityType === 'string' && String(existing.entityType).trim()
      ? String(existing.entityType).trim()
      : levelLabel;
  return {
    ...existing,
    entityType,
    fieldValues,
    ...(options?.customFieldSchema?.length
      ? { customFieldSchema: options.customFieldSchema }
      : existing.customFieldSchema
        ? { customFieldSchema: existing.customFieldSchema }
        : {}),
  };
}

function deriveNodeNameAndCode(
  fieldValues: Record<string, unknown>,
  rawName?: unknown,
  rawCode?: unknown
): { name: string; code: string | null } {
  const explicitName = typeof rawName === 'string' ? rawName.trim() : '';
  const explicitCode = typeof rawCode === 'string' ? rawCode.trim() : rawCode == null ? '' : String(rawCode).trim();
  const fieldName = typeof fieldValues.name === 'string' ? String(fieldValues.name).trim() : '';
  const fieldCode = typeof fieldValues.code === 'string' ? String(fieldValues.code).trim() : '';

  return {
    name: explicitName || fieldName,
    code: (explicitCode || fieldCode || '').trim() || null,
  };
}

function mergeCanonicalFields(
  fieldValues: Record<string, unknown>,
  rawName?: unknown,
  rawCode?: unknown
): Record<string, unknown> {
  const nextFieldValues = { ...fieldValues };
  const explicitName = typeof rawName === 'string' ? rawName.trim() : '';
  const explicitCode = typeof rawCode === 'string' ? rawCode.trim() : rawCode == null ? '' : String(rawCode).trim();

  if (explicitName && nextFieldValues.name === undefined) {
    nextFieldValues.name = explicitName;
  }

  if (explicitCode && nextFieldValues.code === undefined) {
    nextFieldValues.code = explicitCode;
  }

  return nextFieldValues;
}

function validateAndNormalizeFieldValues(
  schema: OrganizationStructureFieldSchemaField[],
  rawValues: Record<string, unknown> | undefined,
  fallbackValues?: Record<string, unknown>
): Record<string, unknown> {
  const sourceValues = rawValues || fallbackValues || {};
  const normalizedValues: Record<string, unknown> = {};

  for (const field of schema) {
    const rawValue = sourceValues[field.key];

    if (rawValue === undefined || rawValue === null || (typeof rawValue === 'string' && !rawValue.trim())) {
      if (field.required) {
        throw new Error(`Field "${field.label}" is required`);
      }
      continue;
    }

    if (field.type === 'number') {
      const numberValue = typeof rawValue === 'number' ? rawValue : Number(String(rawValue).trim());
      if (!Number.isFinite(numberValue)) {
        throw new Error(`Field "${field.label}" must be a valid number`);
      }
      normalizedValues[field.key] = numberValue;
      continue;
    }

    const stringValue = String(rawValue).trim();

    if (!stringValue) {
      if (field.required) {
        throw new Error(`Field "${field.label}" is required`);
      }
      continue;
    }

    if (field.type === 'date' && Number.isNaN(Date.parse(stringValue))) {
      throw new Error(`Field "${field.label}" must be a valid date`);
    }

    if (field.type === 'select' && field.options && !field.options.includes(stringValue)) {
      throw new Error(`Field "${field.label}" must be one of the configured options`);
    }

    if (field.type === 'pincode' && !/^\d{4,10}$/.test(stringValue)) {
      throw new Error(`Field "${field.label}" must be a valid pincode`);
    }

    normalizedValues[field.key] = stringValue;
  }

  return normalizedValues;
}

function mapLevel(row: any): OrganizationStructureLevel {
  return {
    id: row.id,
    organizationId: row.organization_id,
    levelNumber: Number(row.level_number),
    levelKey: row.level_key,
    levelLabel: row.level_label,
    definitionSource: normalizeDefinitionSource(row.definition_source, 'custom'),
    presetKey: row.preset_key ?? null,
    fieldSchemaJson: normalizeFieldSchema(row.field_schema_json, { fallbackToDefault: true }),
    isSystemRequired: Boolean(row.is_system_required),
    isActive: Boolean(row.is_active),
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

function mapNodeBase(row: any): Omit<OrganizationStructureNode, 'path' | 'pathDisplay' | 'pathCodes' | 'pathIds' | 'hasChildren' | 'childrenCount'> {
  const status = normalizeStatus(row.status);
  const metaJson = row.meta_json ?? {};
  const entityFieldFromMeta =
    typeof metaJson.entityType === 'string' && String(metaJson.entityType).trim()
      ? String(metaJson.entityType).trim()
      : null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    stageId: row.stage_id ?? null,
    stageOrder: row.stage_order != null ? Number(row.stage_order) : null,
    stageLabel: row.stage_label ?? null,
    levelId: row.level_id,
    entityField: row.entity_field ?? entityFieldFromMeta,
    levelNumber: Number(row.level_number),
    levelKey: row.level_key,
    levelLabel: row.level_label,
    parentNodeId: row.parent_node_id ?? null,
    parentName: row.parent_name ?? null,
    name: row.name,
    code: row.code ?? null,
    description: row.description ?? null,
    displayOrder: Number(row.display_order ?? 0),
    status,
    isActive: status === 'active',
    metaJson,
    fieldValues: getFieldValuesFromMetaJson(metaJson),
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
    archivedBy: row.archived_by ?? null,
    archivedAt: row.archived_at?.toISOString?.() ?? row.archived_at ?? null,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

async function withClient<T>(handler: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await getClient();
  try {
    return await handler(client);
  } finally {
    client.release?.();
  }
}

async function resolveOrganizationIdFromUser(userId: string): Promise<string | null> {
  const result = await query(
    `SELECT organization_id
     FROM user_organizations
     WHERE user_id = $1
     LIMIT 1`,
    [userId]
  );

  return result.rows[0]?.organization_id || null;
}

export async function resolveOrganizationIdForUser(userId: string, fallbackOrganizationId?: string | null): Promise<string | null> {
  if (fallbackOrganizationId) {
    return fallbackOrganizationId;
  }

  return resolveOrganizationIdFromUser(userId);
}

async function writeAuditLog(
  client: DbClient,
  params: {
    organizationId: string;
    actorUserId?: string | null;
    entityType: string;
    entityId: string;
    action: string;
    beforeValue?: unknown;
    afterValue?: unknown;
    metadata?: unknown;
  }
) {
  await client.query(
    `INSERT INTO organization_structure_audit_logs (
       id,
       organization_id,
       actor_user_id,
       entity_type,
       entity_id,
       action,
       before_value,
       after_value,
       metadata,
       created_at
     )
     VALUES (
       gen_random_uuid(),
       $1,
       $2,
       $3,
       $4,
       $5,
       $6::jsonb,
       $7::jsonb,
       $8::jsonb,
       CURRENT_TIMESTAMP
     )`,
    [
      params.organizationId,
      params.actorUserId || null,
      params.entityType,
      params.entityId,
      params.action,
      params.beforeValue !== undefined ? JSON.stringify(params.beforeValue) : null,
      params.afterValue !== undefined ? JSON.stringify(params.afterValue) : null,
      params.metadata !== undefined ? JSON.stringify(params.metadata) : null,
    ]
  );
}

async function getLevelsInternal(client: DbClient, organizationId: string, includeInactive = true): Promise<OrganizationStructureLevel[]> {
  const params: any[] = [organizationId];
  const conditions = ['organization_id = $1'];

  if (!includeInactive) {
    conditions.push('is_active = TRUE');
  }

  const result = await client.query(
    `SELECT *
     FROM organization_structure_levels
     WHERE ${conditions.join(' AND ')}
     ORDER BY level_number ASC`,
    params
  );

  return result.rows.map(mapLevel);
}

function buildEnrichedNodes(
  nodes: Array<Omit<OrganizationStructureNode, 'path' | 'pathDisplay' | 'pathCodes' | 'pathIds' | 'hasChildren' | 'childrenCount'>>
): OrganizationStructureNode[] {
  const byId = new Map<string, Omit<OrganizationStructureNode, 'path' | 'pathDisplay' | 'pathCodes' | 'pathIds' | 'hasChildren' | 'childrenCount'>>();
  const childrenMap = new Map<string | null, string[]>();

  for (const node of nodes) {
    byId.set(node.id, node);
    const key = node.parentNodeId ?? null;
    const current = childrenMap.get(key) || [];
    current.push(node.id);
    childrenMap.set(key, current);
  }

  return nodes.map((node) => {
    const path: OrganizationStructureNode['path'] = [];
    const visited = new Set<string>();
    let current: typeof node | undefined = node;

    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.unshift({
        id: current.id,
        name: current.name,
        code: current.code,
        levelNumber: current.levelNumber,
        levelKey: current.levelKey,
        levelLabel: current.levelLabel,
        status: current.status,
      });
      current = current.parentNodeId ? byId.get(current.parentNodeId) : undefined;
    }

    const children = childrenMap.get(node.id) || [];

    return {
      ...node,
      path,
      pathDisplay: path.map((item) => item.name).join(' > '),
      pathCodes: path.map((item) => item.code),
      pathIds: path.map((item) => item.id),
      hasChildren: children.length > 0,
      childrenCount: children.length,
    };
  });
}

async function getNodesInternal(
  client: DbClient,
  organizationId: string,
  options?: {
    includeArchived?: boolean;
    includeInactive?: boolean;
  }
): Promise<OrganizationStructureNode[]> {
  const includeArchived = options?.includeArchived ?? true;
  const includeInactive = options?.includeInactive ?? true;

  const conditions = ['n.organization_id = $1'];
  const params: any[] = [organizationId];

  if (!includeArchived) {
    conditions.push(`n.status != 'archived'`);
  }

  if (!includeInactive) {
    conditions.push(`n.status = 'active'`);
  }

  const capabilities = await getOrgStructureSchemaCapabilities(client);
  const stageJoin = capabilities.hasNodeStageId
    ? `LEFT JOIN organization_structure_stages st ON st.id = n.stage_id`
    : '';
  const stageSelect = capabilities.hasNodeStageId
    ? `st.stage_order,
       st.stage_label`
    : `NULL::integer AS stage_order,
       NULL::text AS stage_label`;

  const result = await client.query(
    `SELECT
       n.*,
       parent.name AS parent_name,
       ${stageSelect}
     FROM organization_structure_nodes n
     LEFT JOIN organization_structure_nodes parent ON parent.id = n.parent_node_id
     ${stageJoin}
     WHERE ${conditions.join(' AND ')}
     ORDER BY ${
       capabilities.hasNodeStageId
         ? 'COALESCE(st.stage_order, n.level_number)'
         : 'n.level_number'
     } ASC, n.display_order ASC, n.name ASC`,
    params
  );

  return buildEnrichedNodes(result.rows.map(mapNodeBase));
}

async function getNodeByIdInternal(client: DbClient, organizationId: string, nodeId: string): Promise<OrganizationStructureNode | null> {
  const nodes = await getNodesInternal(client, organizationId, { includeArchived: true, includeInactive: true });
  return nodes.find((node) => node.id === nodeId) || null;
}

async function getLevelByIdInternal(client: DbClient, organizationId: string, levelId: string): Promise<OrganizationStructureLevel | null> {
  const result = await client.query(
    `SELECT *
     FROM organization_structure_levels
     WHERE organization_id = $1
       AND id = $2
     LIMIT 1`,
    [organizationId, levelId]
  );

  return result.rows[0] ? mapLevel(result.rows[0]) : null;
}

async function createLevelInternal(
  client: DbClient,
  params: {
    organizationId: string;
    actorUserId?: string | null;
    levelNumber: number;
    levelLabel: string;
    definitionSource?: OrganizationStructureDefinitionSource;
    presetKey?: string | null;
    fieldSchemaJson?: OrganizationStructureFieldSchemaField[];
  }
): Promise<OrganizationStructureLevel> {
  const levelLabel = String(params.levelLabel || '').trim();
  if (!levelLabel) {
    throw new Error('Level label is required');
  }

  if (params.levelNumber < ROOT_LEVEL_NUMBER) {
    throw new Error('Level number must be 1 or greater');
  }

  const definitionSource = normalizeDefinitionSource(params.definitionSource, params.presetKey ? 'preset' : 'custom');
  const presetKey = typeof params.presetKey === 'string' && params.presetKey.trim() ? params.presetKey.trim() : null;
  const fieldSchemaJson = validateAndNormalizeFieldSchema(params.fieldSchemaJson);

  if (params.levelNumber === ROOT_LEVEL_NUMBER) {
    const existingRoot = await client.query(
      `SELECT *
       FROM organization_structure_levels
       WHERE organization_id = $1
         AND level_number = ${ROOT_LEVEL_NUMBER}
       LIMIT 1`,
      [params.organizationId]
    );
    if (existingRoot.rows.length > 0) {
      return mapLevel(existingRoot.rows[0]);
    }
  }

  const maxLevelResult = await client.query(
    `SELECT COALESCE(MAX(level_number), 0) AS max_level
     FROM organization_structure_levels
     WHERE organization_id = $1`,
    [params.organizationId]
  );
  const assignedLevelNumber = Math.max(
    params.levelNumber === ROOT_LEVEL_NUMBER ? ROOT_LEVEL_NUMBER : 0,
    Number(maxLevelResult.rows[0]?.max_level ?? 0) + 1
  );

  if (assignedLevelNumber > MAX_DEFINED_LEVEL) {
    throw new Error(`Cannot add more than ${MAX_DEFINED_LEVEL} level definitions`);
  }

  const keyBase = slugifyLevelKey(levelLabel);
  let keyValue = keyBase;
  let suffix = 2;

  while (true) {
    const keyResult = await client.query(
      `SELECT 1
       FROM organization_structure_levels
       WHERE organization_id = $1
         AND level_key = $2
       LIMIT 1`,
      [params.organizationId, keyValue]
    );

    if (keyResult.rows.length === 0) {
      break;
    }

    keyValue = `${keyBase}_${suffix}`;
    suffix += 1;
  }

  const insertResult = await client.query(
    `INSERT INTO organization_structure_levels (
       id,
       organization_id,
       level_number,
       level_key,
       level_label,
       definition_source,
       preset_key,
       field_schema_json,
       is_system_required,
       is_active,
       created_by,
       updated_by,
       created_at,
       updated_at
     )
     VALUES (
       gen_random_uuid(),
       $1,
       $2,
       $3,
       $4,
       $5,
       $6,
       $7::jsonb,
       FALSE,
       TRUE,
       $8,
       $8,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
     )
     RETURNING *`,
    [
      params.organizationId,
      assignedLevelNumber,
      keyValue,
      levelLabel,
      definitionSource,
      presetKey,
      JSON.stringify(fieldSchemaJson),
      params.actorUserId || null,
    ]
  );

  const level = mapLevel(insertResult.rows[0]);

  await writeAuditLog(client, {
    organizationId: params.organizationId,
    actorUserId: params.actorUserId,
    entityType: 'level',
    entityId: level.id,
    action: 'created',
    afterValue: level,
  });

  return level;
}

async function attachLevelToStage(
  client: DbClient,
  organizationId: string,
  level: OrganizationStructureLevel,
  preferredStageId?: string | null
): Promise<string | null> {
  let stages = await getStagesInternal(client, organizationId);
  if (stages.length === 0) {
    stages = await ensureStagesForOrganization(client, organizationId, [level]);
    const created = stages.find((stage) => stage.levelIds.includes(level.id));
    return created?.id ?? null;
  }

  if (preferredStageId) {
    await linkLevelToStage(client, organizationId, preferredStageId, level.id);
    return preferredStageId;
  }

  const existing = stages.find((stage) => stage.levelIds.includes(level.id));
  if (existing) {
    return existing.id;
  }

  const maxStageResult = await client.query(
    `SELECT COALESCE(MAX(stage_order), 0) AS max_stage
     FROM organization_structure_stages
     WHERE organization_id = $1`,
    [organizationId]
  );
  const nextStageOrder = Number(maxStageResult.rows[0]?.max_stage ?? 0) + 1;
  const stageInsert = await client.query(
    `INSERT INTO organization_structure_stages (
       id, organization_id, stage_order, stage_label, is_active, created_at, updated_at
     ) VALUES (
       gen_random_uuid(), $1, $2, $3, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     )
     RETURNING id`,
    [organizationId, nextStageOrder, level.levelLabel]
  );
  const stageId = stageInsert.rows[0].id as string;
  await linkLevelToStage(client, organizationId, stageId, level.id);
  return stageId;
}

async function resolveTargetLevelForNodeCreate(
  client: DbClient,
  organizationId: string,
  actorUserId: string,
  levels: OrganizationStructureLevel[],
  input: CreateOrganizationStructureNodeInput,
  _relation: CreateOrganizationStructureNodeInput['relation']
): Promise<OrganizationStructureLevel> {
  if (input.targetLevelId) {
    const level = await getLevelByIdInternal(client, organizationId, input.targetLevelId);
    if (!level) {
      throw new Error('Level not found');
    }
    if (input.stageId) {
      await linkLevelToStage(client, organizationId, input.stageId, level.id);
    }
    return level;
  }

  const sectionLabel = String(input.targetSectionLabel || input.createLevelLabel || '').trim();
  if (!sectionLabel) {
    throw new Error('Level / section is required');
  }

  if (input.stageId) {
    const stages = await getStagesInternal(client, organizationId);
    const stage = stages.find((item) => item.id === input.stageId);
    const inStage = levels.filter(
      (level) =>
        level.levelLabel.trim().toLowerCase() === sectionLabel.toLowerCase() &&
        stage?.levelIds.includes(level.id)
    );
    if (inStage.length === 1) {
      return inStage[0];
    }
  }

  const matchingLevels = levels.filter(
    (level) => level.levelLabel.trim().toLowerCase() === sectionLabel.toLowerCase()
  );
  if (matchingLevels.length > 1) {
    throw new Error('Multiple levels match this section. Select a specific level.');
  }
  if (matchingLevels.length === 1) {
    return matchingLevels[0];
  }

  const newLevel = await createLevelInternal(client, {
    organizationId,
    actorUserId,
    levelNumber: ROOT_LEVEL_NUMBER + 1,
    levelLabel: sectionLabel,
    definitionSource: input.createLevelDefinitionSource,
    presetKey: input.createLevelPresetKey,
    fieldSchemaJson: input.createLevelFieldSchema,
  });
  await attachLevelToStage(client, organizationId, newLevel, input.stageId);
  return newLevel;
}

async function validateNodeNameUnique(
  client: DbClient,
  params: {
    organizationId: string;
    parentNodeId?: string | null;
    name: string;
    excludeNodeId?: string;
  }
) {
  const result = await client.query(
    `SELECT id
     FROM organization_structure_nodes
     WHERE organization_id = $1
       AND (
         (parent_node_id IS NULL AND $2::uuid IS NULL)
         OR parent_node_id = $2
       )
       AND LOWER(name) = LOWER($3)
       ${params.excludeNodeId ? 'AND id != $4' : ''}
     LIMIT 1`,
    params.excludeNodeId
      ? [params.organizationId, params.parentNodeId || null, params.name.trim(), params.excludeNodeId]
      : [params.organizationId, params.parentNodeId || null, params.name.trim()]
  );

  if (result.rows.length > 0) {
    throw new Error('A node with this name already exists under the selected parent');
  }
}

async function validateNodeCodeUnique(
  client: DbClient,
  params: {
    organizationId: string;
    code?: string | null;
    excludeNodeId?: string;
  }
) {
  const normalizedCode = String(params.code || '').trim();
  if (!normalizedCode) {
    return;
  }

  const result = await client.query(
    `SELECT id
     FROM organization_structure_nodes
     WHERE organization_id = $1
       AND LOWER(code) = LOWER($2)
       ${params.excludeNodeId ? 'AND id != $3' : ''}
     LIMIT 1`,
    params.excludeNodeId
      ? [params.organizationId, normalizedCode, params.excludeNodeId]
      : [params.organizationId, normalizedCode]
  );

  if (result.rows.length > 0) {
    throw new Error('A node with this code already exists');
  }
}

async function validateNodeReferences(
  client: DbClient,
  organizationId: string,
  nodeId: string,
  options?: { activeOnly?: boolean }
): Promise<OrganizationStructureNode> {
  const node = await getNodeByIdInternal(client, organizationId, nodeId);

  if (!node) {
    throw new Error('Organization structure node not found');
  }

  if (options?.activeOnly && node.status !== 'active') {
    throw new Error('Selected organization unit is not active');
  }

  return node;
}

async function getNodePathInternal(
  client: DbClient,
  organizationId: string,
  nodeId: string
): Promise<OrganizationStructureNode['path']> {
  const node = await getNodeByIdInternal(client, organizationId, nodeId);
  return node?.path || [];
}

export async function resolveNodeReference(
  organizationId: string,
  nodeId: string,
  options?: { activeOnly?: boolean }
): Promise<{
  nodeId: string;
  levelKey: string;
  levelLabel: string;
  levelNumber: number;
  path: OrganizationStructureNode['path'];
  pathDisplay: string;
}> {
  return withClient(async (client) => {
    const node = await validateNodeReferences(client, organizationId, nodeId, options);
    return {
      nodeId: node.id,
      levelKey: node.levelKey,
      levelLabel: node.levelLabel,
      levelNumber: node.levelNumber,
      path: node.path,
      pathDisplay: node.pathDisplay,
    };
  });
}

export async function getOrganizationStructureLevels(organizationId: string): Promise<OrganizationStructureLevel[]> {
  const tree = await getOrganizationStructureTree(organizationId, {
    includeArchived: true,
    includeInactive: true,
  });
  return tree.levels;
}

export async function updateOrganizationStructureLevel(
  organizationId: string,
  actorUserId: string,
  levelId: string,
  input: UpdateOrganizationStructureLevelInput
): Promise<OrganizationStructureLevel> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const existingLevel = await getLevelByIdInternal(client, organizationId, levelId);
      if (!existingLevel) {
        throw new Error('Organization structure level not found');
      }

      const nextLevelLabel = input.levelLabel !== undefined ? String(input.levelLabel || '').trim() : existingLevel.levelLabel;
      if (!nextLevelLabel) {
        throw new Error('Level label is required');
      }

      const nextDefinitionSource =
        input.definitionSource !== undefined
          ? normalizeDefinitionSource(input.definitionSource, input.presetKey ? 'preset' : existingLevel.definitionSource)
          : existingLevel.definitionSource;
      const nextPresetKey =
        input.presetKey !== undefined
          ? typeof input.presetKey === 'string' && input.presetKey.trim()
            ? input.presetKey.trim()
            : null
          : existingLevel.presetKey || null;
      const nextFieldSchema =
        input.fieldSchemaJson !== undefined
          ? validateAndNormalizeFieldSchema(input.fieldSchemaJson)
          : normalizeFieldSchema(existingLevel.fieldSchemaJson, { fallbackToDefault: true });
      const nextKeyBase = slugifyLevelKey(nextLevelLabel);
      let nextLevelKey = nextKeyBase;
      let suffix = 2;

      while (true) {
        const keyResult = await client.query(
          `SELECT 1
           FROM organization_structure_levels
           WHERE organization_id = $1
             AND level_key = $2
             AND id != $3
           LIMIT 1`,
          [organizationId, nextLevelKey, levelId]
        );

        if (keyResult.rows.length === 0) {
          break;
        }

        nextLevelKey = `${nextKeyBase}_${suffix}`;
        suffix += 1;
      }

      const labelConflict = await client.query(
        `SELECT 1
         FROM organization_structure_levels
         WHERE organization_id = $1
           AND LOWER(level_label) = LOWER($2)
           AND id != $3
         LIMIT 1`,
        [organizationId, nextLevelLabel, levelId]
      );

      if (labelConflict.rows.length > 0) {
        throw new Error(`Level "${nextLevelLabel}" already exists`);
      }

      const updateResult = await client.query(
        `UPDATE organization_structure_levels
         SET level_key = $1,
             level_label = $2,
             definition_source = $3,
             preset_key = $4,
             field_schema_json = $5::jsonb,
             is_active = $6,
             updated_by = $7,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $8
           AND organization_id = $9
         RETURNING *`,
        [
          nextLevelKey,
          nextLevelLabel,
          nextDefinitionSource,
          nextPresetKey,
          JSON.stringify(nextFieldSchema),
          input.isActive !== undefined ? Boolean(input.isActive) : existingLevel.isActive,
          actorUserId,
          levelId,
          organizationId,
        ]
      );

      await client.query(
        `UPDATE organization_structure_nodes
         SET level_key = $1,
             level_label = $2,
             meta_json = jsonb_set(
               COALESCE(meta_json, '{}'::jsonb),
               '{entityType}',
               to_jsonb($2::text),
               true
             ),
             updated_by = $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE organization_id = $4
           AND level_id = $5`,
        [nextLevelKey, nextLevelLabel, actorUserId, organizationId, levelId]
      );

      const updatedLevel = mapLevel(updateResult.rows[0]);

      await writeAuditLog(client, {
        organizationId,
        actorUserId,
        entityType: 'level',
        entityId: levelId,
        action: 'updated',
        beforeValue: existingLevel,
        afterValue: updatedLevel,
      });

      await client.query('COMMIT');
      return updatedLevel;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

export async function getOrganizationStructureTree(
  organizationId: string,
  options?: {
    includeArchived?: boolean;
    includeInactive?: boolean;
  }
): Promise<OrganizationStructureTree> {
  return withClient(async (client) => {
    const levels = await getLevelsInternal(client, organizationId, true);
    let stages = await getStagesInternal(client, organizationId);
    if (stages.length === 0 && levels.length > 0) {
      stages = await ensureStagesForOrganization(client, organizationId, levels);
    }
    const nodes = await getNodesInternal(client, organizationId, options);
    const rootNode = nodes.find((node) => !node.parentNodeId) || null;
    const levelsInUse = filterLevelsUsedOnTree(levels, nodes);

    return {
      stages,
      levels: levelsInUse,
      catalogLevels: levels,
      nodes,
      rootNode,
      summary: {
        totalStages: stages.length,
        totalLevels: levelsInUse.length,
        catalogLevelCount: levels.length,
        totalNodes: nodes.length,
        activeNodes: nodes.filter((node) => node.status === 'active').length,
        archivedNodes: nodes.filter((node) => node.status === 'archived').length,
        hasRootNode: Boolean(rootNode),
      },
    };
  });
}

export async function getOrganizationStructureStages(organizationId: string): Promise<OrganizationStructureStage[]> {
  return withClient(async (client) => {
    const levels = await getLevelsInternal(client, organizationId, true);
    let stages = await getStagesInternal(client, organizationId);
    if (stages.length === 0 && levels.length > 0) {
      stages = await ensureStagesForOrganization(client, organizationId, levels);
    }
    return stages;
  });
}

/** Create node using an existing DB client (no transaction). Used by bulk upload inside outer transactions. */
export async function createOrganizationStructureNodeWithClient(
  client: DbClient,
  organizationId: string,
  actorUserId: string,
  input: CreateOrganizationStructureNodeInput
): Promise<OrganizationStructureNode> {
  const levels = await getLevelsInternal(client, organizationId, true);
      const relation = input.relation;
      let targetLevel: OrganizationStructureLevel | undefined;
      let parentNodeId: string | null = null;
      let referenceNode: OrganizationStructureNode | null = null;

      if (relation === 'root') {
        const rootExists = await client.query(
          `SELECT id, name, level_label
           FROM organization_structure_nodes
           WHERE organization_id = $1
             AND parent_node_id IS NULL
           LIMIT 1`,
          [organizationId]
        );

        if (rootExists.rows.length > 0) {
          const existing = rootExists.rows[0];
          throw new Error(
            `Root entity already exists (${existing.name || existing.level_label || existing.id}). Add children under it instead.`
          );
        }

        targetLevel = await resolveTargetLevelForNodeCreate(
          client,
          organizationId,
          actorUserId,
          levels,
          input,
          relation
        );
      } else {
        if (!input.referenceNodeId && !input.parentNodeId) {
          throw new Error('Reference node or parent node is required');
        }

        referenceNode = input.referenceNodeId
          ? await validateNodeReferences(client, organizationId, input.referenceNodeId)
          : null;

        if (input.parentNodeId) {
          const explicitParent = await validateNodeReferences(client, organizationId, input.parentNodeId);
          if (explicitParent.status !== 'active') {
            throw new Error('Cannot attach under an inactive or archived parent');
          }
          parentNodeId = explicitParent.id;
        } else if (referenceNode) {
          if (relation === 'sibling') {
            if (!referenceNode.parentNodeId) {
              throw new Error(
                'The root node cannot have siblings. Add a child under the root, or select another parent.'
              );
            }
            parentNodeId = referenceNode.parentNodeId;
          } else {
            if (referenceNode.status !== 'active') {
              throw new Error('Cannot add child under an inactive or archived parent');
            }
            parentNodeId = referenceNode.id;
          }
        }

        targetLevel = await resolveTargetLevelForNodeCreate(
          client,
          organizationId,
          actorUserId,
          levels,
          input,
          relation
        );
      }

      if (!targetLevel) {
        throw new Error('Target hierarchy level is not available');
      }

      const levelFieldSchema = normalizeFieldSchema(targetLevel.fieldSchemaJson, { fallbackToDefault: true });
      const normalizedFieldValues = validateAndNormalizeFieldValues(
        levelFieldSchema,
        mergeCanonicalFields(
          {
            ...getFieldValuesFromMetaJson(input.metaJson),
            ...(input.fieldValues || {}),
          },
          input.name,
          input.code
        )
      );
      const { name, code } = deriveNodeNameAndCode(normalizedFieldValues, input.name, input.code);

      if (!name) {
        throw new Error('Node name is required');
      }

      await validateNodeNameUnique(client, {
        organizationId,
        parentNodeId,
        name,
      });

      await validateNodeCodeUnique(client, {
        organizationId,
        code,
      });

      const siblingOrderResult = await client.query(
        `SELECT COALESCE(MAX(display_order), -1) AS max_display_order
         FROM organization_structure_nodes
         WHERE organization_id = $1
           AND (
             (parent_node_id IS NULL AND $2::uuid IS NULL)
             OR parent_node_id = $2
           )`,
        [organizationId, parentNodeId]
      );

      const displayOrder = Number(siblingOrderResult.rows[0]?.max_display_order ?? -1) + 1;
      const status = normalizeStatus(input.status, 'active');
      const entityField =
        String(input.entityField || '').trim() ||
        (typeof input.metaJson?.entityType === 'string' ? String(input.metaJson.entityType).trim() : '') ||
        targetLevel.levelLabel;
      const nextMetaJson = buildNodeMetaJson(
        { ...(input.metaJson || {}), entityType: entityField },
        targetLevel.levelLabel,
        normalizedFieldValues
      );

      const schemaCaps = await getOrgStructureSchemaCapabilities(client);
      let resolvedStageId: string | null = null;

      if (schemaCaps.hasStagesTable) {
        const parentNode = parentNodeId
          ? await validateNodeReferences(client, organizationId, parentNodeId)
          : null;
        const stageOrder = resolveStageOrderForNodeCreate(relation, parentNode, referenceNode);
        resolvedStageId = await ensureStageAtOrder(client, organizationId, stageOrder);
        if (resolvedStageId) {
          await linkLevelToStage(client, organizationId, resolvedStageId, targetLevel.id);
        }
      }

      let insertResult;
      if (schemaCaps.hasNodeStageId && schemaCaps.hasNodeEntityField) {
        insertResult = await client.query(
          `INSERT INTO organization_structure_nodes (
             id, organization_id, stage_id, level_id, level_number, level_key, level_label,
             entity_field, parent_node_id, name, code, description, display_order, status,
             meta_json, created_by, updated_by, created_at, updated_at
           )
           VALUES (
             gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14::jsonb, $15, $15, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           )
           RETURNING *`,
          [
            organizationId,
            resolvedStageId,
            targetLevel.id,
            targetLevel.levelNumber,
            targetLevel.levelKey,
            targetLevel.levelLabel,
            entityField,
            parentNodeId,
            name,
            code,
            input.description?.trim() || null,
            displayOrder,
            status,
            JSON.stringify(nextMetaJson),
            actorUserId,
          ]
        );
      } else if (schemaCaps.hasNodeStageId) {
        insertResult = await client.query(
          `INSERT INTO organization_structure_nodes (
             id, organization_id, stage_id, level_id, level_number, level_key, level_label,
             parent_node_id, name, code, description, display_order, status,
             meta_json, created_by, updated_by, created_at, updated_at
           )
           VALUES (
             gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13::jsonb, $14, $14, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           )
           RETURNING *`,
          [
            organizationId,
            resolvedStageId,
            targetLevel.id,
            targetLevel.levelNumber,
            targetLevel.levelKey,
            targetLevel.levelLabel,
            parentNodeId,
            name,
            code,
            input.description?.trim() || null,
            displayOrder,
            status,
            JSON.stringify(nextMetaJson),
            actorUserId,
          ]
        );
      } else {
        insertResult = await client.query(
          `INSERT INTO organization_structure_nodes (
             id, organization_id, level_id, level_number, level_key, level_label,
             parent_node_id, name, code, description, display_order, status,
             meta_json, created_by, updated_by, created_at, updated_at
           )
           VALUES (
             gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12::jsonb, $13, $13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
           )
           RETURNING *`,
          [
            organizationId,
            targetLevel.id,
            targetLevel.levelNumber,
            targetLevel.levelKey,
            targetLevel.levelLabel,
            parentNodeId,
            name,
            code,
            input.description?.trim() || null,
            displayOrder,
            status,
            JSON.stringify(nextMetaJson),
            actorUserId,
          ]
        );
      }

      const createdNode = mapNodeBase(insertResult.rows[0]);

  await writeAuditLog(client, {
    organizationId,
    actorUserId,
    entityType: 'node',
    entityId: createdNode.id,
    action: 'created',
    afterValue: createdNode,
    metadata: { relation, referenceNodeId: input.referenceNodeId || null },
  });

  return (await getNodeByIdInternal(client, organizationId, createdNode.id)) as OrganizationStructureNode;
}

export async function createOrganizationStructureNode(
  organizationId: string,
  actorUserId: string,
  input: CreateOrganizationStructureNodeInput
): Promise<OrganizationStructureNode> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const created = await createOrganizationStructureNodeWithClient(
        client,
        organizationId,
        actorUserId,
        input
      );
      await client.query('COMMIT');
      return created;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

export async function updateOrganizationStructureNode(
  organizationId: string,
  actorUserId: string,
  nodeId: string,
  input: UpdateOrganizationStructureNodeInput
): Promise<OrganizationStructureNode> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const existingNode = await validateNodeReferences(client, organizationId, nodeId);
      const levels = await getLevelsInternal(client, organizationId, true);
      const targetLevel = levels.find((level) => level.id === existingNode.levelId);
      if (!targetLevel) {
        throw new Error('Target hierarchy level is not available');
      }

      if (!existingNode.parentNodeId && input.status === 'archived') {
        throw new Error('Root entity cannot be archived');
      }

      const nextStatus = input.status !== undefined ? normalizeStatus(input.status, existingNode.status) : existingNode.status;
      const mergedFieldValues = mergeCanonicalFields(
        {
          ...getFieldValuesFromMetaJson(existingNode.metaJson),
          ...(input.fieldValues || {}),
        },
        input.name !== undefined ? input.name : existingNode.name,
        input.code !== undefined ? input.code : existingNode.code
      );
      const existingMeta =
        (input.metaJson !== undefined ? input.metaJson : existingNode.metaJson) as Record<string, unknown>;
      const customFieldSchema = getCustomFieldSchemaFromMeta(existingMeta);
      const validationSchema = mergeFieldSchemasByKey(
        normalizeFieldSchema(targetLevel.fieldSchemaJson, { fallbackToDefault: true }),
        ORG_STRUCTURE_EXTENDED_FIELD_CATALOG,
        customFieldSchema
      );
      const normalizedFieldValues = validateAndNormalizeFieldValues(validationSchema, mergedFieldValues);
      const derivedIdentity = deriveNodeNameAndCode(
        normalizedFieldValues,
        input.name !== undefined ? input.name : existingNode.name,
        input.code !== undefined ? input.code : existingNode.code
      );
      const nextName = derivedIdentity.name;
      const nextCode = derivedIdentity.code;

      if (!nextName) {
        throw new Error('Node name is required');
      }

      await validateNodeNameUnique(client, {
        organizationId,
        parentNodeId: existingNode.parentNodeId,
        name: nextName,
        excludeNodeId: nodeId,
      });

      await validateNodeCodeUnique(client, {
        organizationId,
        code: nextCode,
        excludeNodeId: nodeId,
      });

      const updateResult = await client.query(
        `UPDATE organization_structure_nodes
         SET name = $1,
             code = $2,
             description = $3,
             status = $4,
             meta_json = $5::jsonb,
             updated_by = $6,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $7
           AND organization_id = $8
         RETURNING *`,
        [
          nextName,
          nextCode,
          input.description !== undefined ? input.description?.trim() || null : existingNode.description || null,
          nextStatus,
          JSON.stringify(
            buildNodeMetaJson(
              input.metaJson !== undefined ? input.metaJson : existingNode.metaJson,
              targetLevel.levelLabel,
              normalizedFieldValues,
              { customFieldSchema }
            )
          ),
          actorUserId,
          nodeId,
          organizationId,
        ]
      );

      const updatedNode = mapNodeBase(updateResult.rows[0]);

      await writeAuditLog(client, {
        organizationId,
        actorUserId,
        entityType: 'node',
        entityId: nodeId,
        action: 'updated',
        beforeValue: existingNode,
        afterValue: updatedNode,
      });

      await client.query('COMMIT');
      return (await getNodeByIdInternal(client, organizationId, nodeId)) as OrganizationStructureNode;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

export async function archiveOrganizationStructureNode(
  organizationId: string,
  actorUserId: string,
  nodeId: string
): Promise<OrganizationStructureNode> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const existingNode = await validateNodeReferences(client, organizationId, nodeId);

      if (!existingNode.parentNodeId) {
        throw new Error('Root entity cannot be archived');
      }

      await client.query(
        `UPDATE organization_structure_nodes
         SET status = 'archived',
             archived_by = $1,
             archived_at = CURRENT_TIMESTAMP,
             updated_by = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2
           AND organization_id = $3`,
        [actorUserId, nodeId, organizationId]
      );

      await writeAuditLog(client, {
        organizationId,
        actorUserId,
        entityType: 'node',
        entityId: nodeId,
        action: 'archived',
        beforeValue: existingNode,
      });

      await client.query('COMMIT');
      return (await getNodeByIdInternal(client, organizationId, nodeId)) as OrganizationStructureNode;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function collectNodeSubtreeIds(
  client: DbClient,
  organizationId: string,
  nodeId: string
): Promise<string[]> {
  const subtreeResult = await client.query(
    `WITH RECURSIVE subtree AS (
       SELECT id, 0 AS depth
       FROM organization_structure_nodes
       WHERE id = $1
         AND organization_id = $2
       UNION ALL
       SELECT child.id, subtree.depth + 1
       FROM organization_structure_nodes child
       INNER JOIN subtree ON child.parent_node_id = subtree.id
       WHERE child.organization_id = $2
     )
     SELECT id
     FROM subtree
     ORDER BY depth DESC`,
    [nodeId, organizationId]
  );

  return subtreeResult.rows.map((row: { id: string }) => row.id);
}

export async function deleteOrganizationStructureNode(
  organizationId: string,
  actorUserId: string,
  nodeId: string
): Promise<{ deletedCount: number; deletedNodeIds: string[] }> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const existingNode = await validateNodeReferences(client, organizationId, nodeId);
      const subtreeIds = await collectNodeSubtreeIds(client, organizationId, nodeId);

      if (subtreeIds.length === 0) {
        throw new Error('Organization structure node not found');
      }

      const taskReferenceResult = await client.query(
        `SELECT 1
         FROM tasks
         WHERE organization_id = $1
           AND org_structure_node_id = ANY($2::uuid[])
         LIMIT 1`,
        [organizationId, subtreeIds]
      );

      if (taskReferenceResult.rows.length > 0) {
        throw new Error(
          'Node cannot be deleted because tasks reference this node or one of its descendants'
        );
      }

      const employeeReferenceResult = await client.query(
        `SELECT 1
         FROM user_organizations
         WHERE organization_id = $1
           AND (
             primary_org_node_id = ANY($2::uuid[])
             OR secondary_org_node_ids && $2::uuid[]
           )
         LIMIT 1`,
        [organizationId, subtreeIds]
      );

      if (employeeReferenceResult.rows.length > 0) {
        throw new Error(
          'Node cannot be deleted because employees are assigned to this node or one of its descendants'
        );
      }

      await client.query(
        `DELETE FROM organization_structure_nodes
         WHERE organization_id = $1
           AND id = ANY($2::uuid[])`,
        [organizationId, subtreeIds]
      );

      await writeAuditLog(client, {
        organizationId,
        actorUserId,
        entityType: 'node',
        entityId: nodeId,
        action: 'deleted',
        beforeValue: existingNode,
        metadata: {
          cascade: true,
          deletedCount: subtreeIds.length,
          deletedNodeIds: subtreeIds,
        },
      });

      await client.query('COMMIT');
      return {
        deletedCount: subtreeIds.length,
        deletedNodeIds: subtreeIds,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

export async function getOrganizationStructureOperationalOptions(organizationId: string) {
  const tree = await getOrganizationStructureTree(organizationId, {
    includeArchived: false,
    includeInactive: false,
  });

  return {
    levels: tree.levels.filter((level) => level.isActive),
    nodes: tree.nodes.filter((node) => node.status === 'active'),
    groupedByLevel: tree.levels
      .filter((level) => level.isActive)
      .map((level) => ({
        levelNumber: level.levelNumber,
        levelKey: level.levelKey,
        levelLabel: level.levelLabel,
        nodes: tree.nodes
          .filter((node) => node.status === 'active' && node.levelNumber === level.levelNumber)
          .map((node) => ({
            id: node.id,
            name: node.name,
            code: node.code,
            pathDisplay: node.pathDisplay,
            parentNodeId: node.parentNodeId,
            levelNumber: node.levelNumber,
            levelKey: node.levelKey,
            levelLabel: node.levelLabel,
          })),
      })),
  };
}

async function queryOptionalRows(client: DbClient, sql: string, params: any[]): Promise<any[]> {
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } catch (error: any) {
    if (error?.code === '42P01' || error?.code === '42703') {
      return [];
    }

    throw error;
  }
}

export async function getReportingRollups(organizationId: string) {
  return withClient(async (client) => {
    const tree = await getOrganizationStructureTree(organizationId, {
      includeArchived: true,
      includeInactive: true,
    });

    const [taskRows, primaryEmployeeRows, secondaryEmployeeRows] = await Promise.all([
      queryOptionalRows(
        client,
        `SELECT org_structure_node_id AS node_id, COUNT(*) AS total
         FROM tasks
         WHERE organization_id = $1
           AND org_structure_node_id IS NOT NULL
         GROUP BY org_structure_node_id`,
        [organizationId]
      ),
      queryOptionalRows(
        client,
        `SELECT primary_org_node_id AS node_id, COUNT(*) AS total
         FROM user_organizations
         WHERE organization_id = $1
           AND primary_org_node_id IS NOT NULL
         GROUP BY primary_org_node_id`,
        [organizationId]
      ),
      queryOptionalRows(
        client,
        `SELECT secondary_node_id AS node_id, COUNT(*) AS total
         FROM (
           SELECT UNNEST(COALESCE(secondary_org_node_ids, ARRAY[]::uuid[])) AS secondary_node_id
           FROM user_organizations
           WHERE organization_id = $1
         ) secondary_nodes
         WHERE secondary_node_id IS NOT NULL
         GROUP BY secondary_node_id`,
        [organizationId]
      ),
    ]);

    const directTaskCounts = new Map<string, number>();
    const directPrimaryEmployeeCounts = new Map<string, number>();
    const directSecondaryEmployeeCounts = new Map<string, number>();

    taskRows.forEach((row: any) => directTaskCounts.set(String(row.node_id), Number(row.total || 0)));
    primaryEmployeeRows.forEach((row: any) => directPrimaryEmployeeCounts.set(String(row.node_id), Number(row.total || 0)));
    secondaryEmployeeRows.forEach((row: any) => directSecondaryEmployeeCounts.set(String(row.node_id), Number(row.total || 0)));

    const rollupTaskCounts = new Map<string, number>();
    const rollupEmployeeCounts = new Map<string, number>();

    for (const node of tree.nodes) {
      const taskCount = directTaskCounts.get(node.id) || 0;
      const employeeCount = (directPrimaryEmployeeCounts.get(node.id) || 0) + (directSecondaryEmployeeCounts.get(node.id) || 0);

      for (const pathId of node.pathIds) {
        rollupTaskCounts.set(pathId, (rollupTaskCounts.get(pathId) || 0) + taskCount);
        rollupEmployeeCounts.set(pathId, (rollupEmployeeCounts.get(pathId) || 0) + employeeCount);
      }
    }

    return tree.nodes.map((node) => ({
      nodeId: node.id,
      name: node.name,
      code: node.code,
      levelLabel: node.levelLabel,
      levelKey: node.levelKey,
      levelNumber: node.levelNumber,
      pathDisplay: node.pathDisplay,
      directTaskCount: directTaskCounts.get(node.id) || 0,
      rollupTaskCount: rollupTaskCounts.get(node.id) || 0,
      directEmployeeCount: (directPrimaryEmployeeCounts.get(node.id) || 0) + (directSecondaryEmployeeCounts.get(node.id) || 0),
      rollupEmployeeCount: rollupEmployeeCounts.get(node.id) || 0,
      status: node.status,
    }));
  });
}

export async function getHierarchyReferenceForNode(organizationId: string, nodeId?: string | null) {
  if (!nodeId) {
    return {
      nodeId: null,
      levelKey: null,
      levelLabel: null,
      levelNumber: null,
      path: [],
      pathDisplay: '',
    };
  }

  const ref = await resolveNodeReference(organizationId, nodeId, { activeOnly: false });
  return ref;
}

export async function getNodePath(organizationId: string, nodeId: string) {
  return withClient(async (client) => getNodePathInternal(client, organizationId, nodeId));
}

/** Validate dynamic field values against the schema for the node's level. */
export async function validateOrgFieldValuesForNode(
  organizationId: string,
  nodeId: string,
  rawValues: Record<string, unknown> | undefined
): Promise<Record<string, unknown>> {
  const tree = await getOrganizationStructureTree(organizationId, {
    includeArchived: true,
    includeInactive: true,
  });
  const node = tree.nodes.find((item) => item.id === nodeId);
  if (!node) {
    throw new Error('Organization structure node not found');
  }
  const level = tree.levels.find((item) => item.levelNumber === node.levelNumber);
  const schema = level?.fieldSchemaJson?.length
    ? level.fieldSchemaJson
    : normalizeFieldSchema(null, { fallbackToDefault: true });
  return validateAndNormalizeFieldValues(schema, rawValues);
}

export function getFieldSchemaForLevel(
  tree: OrganizationStructureTree,
  levelNumber: number
): OrganizationStructureFieldSchemaField[] {
  const level = tree.levels.find((item) => item.levelNumber === levelNumber);
  if (level?.fieldSchemaJson?.length) {
    return level.fieldSchemaJson;
  }
  return normalizeFieldSchema(null, { fallbackToDefault: true });
}
