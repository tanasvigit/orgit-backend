import ExcelJS from 'exceljs';
import bcrypt from 'bcryptjs';
import { PoolClient } from 'pg';
import { getClient, query } from '../config/database';
import { ORG_CONSTITUTION_VALUES, ORG_CONSTITUTION_OPTIONS } from './masterDataService';
import { applyTaskBulkSheetValidations } from './taskBulkService';
import {
  resolveNodeReference,
  type OrganizationStructureLevel,
  type OrganizationStructureNode,
  type OrganizationStructureTree,
} from './organizationStructureService';
import {
  addInstructionsSheet,
  addOrganisationStructureDataSheet,
  addSectionEntityFieldReferenceSheet,
  applyBulkTemplateEnhancements,
} from './orgStructureBulkTemplate';
import {
  buildOrgFieldValuesPayload,
  findDeprecatedSheets,
  findLegacyEntityListColumns,
  findLevelColumnIndices,
  getActiveLevelsFromL2,
  getDeepestSelectedNodeId,
  loadOrganizationStructureLevels,
  loadTreeForBulk,
  parseOrganizationStructureSheet,
  parseOrgNodeByLevelFromRow,
  resolveOrgStructureNodeFromHint,
  type OrgNodeByLevel,
} from './orgStructureBulkUtils';

const TASK_FREQUENCIES = ['Daily', 'Weekly', 'Fortnightly', 'Monthly', 'Quarterly', 'Half Yearly', 'Yearly', 'NA', 'Custom'];
const TASK_TYPES = ['recurring', 'one_time'];
const ROLLOUT_RULES = ['end_of_period', 'one_month_before_period_end'];
const DEFAULT_EMPLOYEE_PASSWORD = '12345678';

/** Fetch recurring task service titles from task_services (global when organizationId is null, or org-specific). Used for Entity List columns and parsing. */
export async function getRecurringTaskServiceTitles(organizationId: string | null, client?: PoolClient | null): Promise<string[]> {
  const sql = `SELECT DISTINCT title FROM task_services
     WHERE task_type = 'recurring' AND is_active = true
     AND (organization_id IS NOT DISTINCT FROM $1)
     ORDER BY title`;
  const res = client ? await client.query(sql, [organizationId]) : await query(sql, [organizationId]);
  return (res.rows ?? []).map((r: { title: string }) => r.title);
}

/** Recurring task service titles for Entity List parsing: global + org-specific (so upload accepts both). */
async function getRecurringTaskServiceTitlesForEntityList(organizationId: string | null, client: PoolClient): Promise<string[]> {
  const sql = organizationId
    ? `SELECT DISTINCT title FROM task_services
       WHERE task_type = 'recurring' AND is_active = true
       AND (organization_id IS NULL OR organization_id = $1)
       ORDER BY title`
    : `SELECT DISTINCT title FROM task_services
       WHERE task_type = 'recurring' AND is_active = true AND organization_id IS NULL
       ORDER BY title`;
  const res = await client.query(sql, organizationId ? [organizationId] : []);
  return (res.rows ?? []).map((r: { title: string }) => r.title);
}

/** Entity Master (Organisation) vertical layout: label in column A, value in column B. */
const ENTITY_MASTER_VERTICAL_FIELDS: { label: string; key: string }[] = [
  { label: 'Name of the Organisation', key: 'name' },
  { label: 'Short Name /Trade Name/ Business Name', key: 'short_name' },
  { label: 'Address of the Organisation', key: 'address' },
  { label: 'E Mail ID', key: 'email' },
  { label: 'Web Site', key: 'website' },
  { label: 'Phone Number', key: 'phone_number' },
  { label: 'Entity Type', key: 'org_constitution' },
  { label: 'Registration Number of the Entity', key: 'cin' },
  { label: 'PAN of the Entity', key: 'pan' },
  { label: 'GST Number', key: 'gst' },
  { label: 'Country', key: 'country_name' },
  { label: 'State', key: 'state_name' },
  { label: 'City', key: 'city_name' },
  { label: 'Pin Code', key: 'pin_code' },
  { label: 'Address Line 1', key: 'address_line1' },
  { label: 'Address Line 2', key: 'address_line2' },
];

/**
 * Template-only vertical fields for the "Entity Master Data (Org)" sheet.
 * Keep this list minimal (as per latest UI); upload remains backward-compatible
 * because parsing still uses ENTITY_MASTER_VERTICAL_FIELDS + legacy label mapping.
 */
const ENTITY_MASTER_TEMPLATE_VERTICAL_FIELDS: { label: string; key: string }[] = [
  { label: 'Name of the Organisation', key: 'name' },
  { label: 'Short Name /Trade Name/ Business Name', key: 'short_name' },
  { label: 'Phone Number', key: 'phone_number' },
  { label: 'E Mail ID', key: 'email' },
  { label: 'Web Site', key: 'website' },
  { label: 'Entity Type', key: 'org_constitution' }, // Org Constitution
  { label: 'Country', key: 'country_name' },
  { label: 'State', key: 'state_name' },
  { label: 'City', key: 'city_name' },
  { label: 'Pin Code', key: 'pin_code' },
  { label: 'Address Line 1', key: 'address_line1' },
  { label: 'Address Line 2', key: 'address_line2' },
  { label: 'GST Number', key: 'gst' },
  { label: 'PAN of the Entity', key: 'pan' }, // PAN of the Organisation
  { label: 'Registration Number of the Entity', key: 'cin' }, // CIN Number
];
/** Legacy vertical labels (old template) → key; used when exact label not in ENTITY_MASTER_VERTICAL_FIELDS. */
const ENTITY_MASTER_LEGACY_LABELS: Record<string, string> = {
  'org constitution': 'org_constitution',
  'pan of the organisation': 'pan',
  'pan of the entity': 'pan',
  'gst number': 'gst',
  'cin number': 'cin',
  'registration number of the entity': 'cin',
  'phone number': 'phone_number',
  'e mail id': 'email',
  'web site': 'website',
};

/** Bulk upload limits and safety */
const MAX_ROWS_PER_SHEET = 50000;
const MAX_ERRORS_REPORTED = 1000;
const STRING_MAX = 500;
const NAME_MAX = 255;
const TITLE_MAX = 500;
/** DB VARCHAR(20) for phone_number and pin_code */
const PHONE_PIN_MAX = 20;

export interface UploadResult {
  updated: {
    organizations: number;
    organization_structure_nodes: number;
    task_services: number;
    client_entities: number;
    client_entity_services: number;
    employees: number;
  };
  errors: Array<{ sheet?: string; row?: number; message: string }>;
}

function buildEntityListSheetColumns(
  complianceHeaders: string[],
  _levelsOrTree: OrganizationStructureLevel[] | OrganizationStructureTree
) {
  return [
    { header: 'NAME OF THE CLIENT', key: 'name', width: 28 },
    { header: 'ENTITY TYPE', key: 'entity_type', width: 18 },
    { header: 'STATUS', key: 'status', width: 14 },
    { header: 'ORG UNIT MAPPING', key: 'org_unit_mapping', width: 30 },
    { header: 'PAN', key: 'pan', width: 16 },
    { header: 'REPORTING PARTNER', key: 'reporting_partner_mobile', width: 20, style: { numFmt: '@' } as any },
    ...complianceHeaders.map((h, i) => ({ header: h, key: `col_${i}`, width: Math.min(28, h.length + 2) })),
  ];
}

function buildEmployeeSheetColumns(
  _levelsOrTree: OrganizationStructureLevel[] | OrganizationStructureTree
) {
  return [
    { header: 'EMPLOYEE ID', key: 'employee_code', width: 14 },
    { header: 'NAME OF THE EMPLOYEE', key: 'name', width: 28 },
    { header: 'MOBILE NUMBER', key: 'mobile', width: 16 },
    { header: 'EMAIL ID', key: 'email', width: 24 },
    { header: 'DOB', key: 'dob', width: 12 },
    { header: 'GENDER', key: 'gender', width: 12 },
    { header: 'ADDRESS', key: 'address', width: 32 },
    { header: 'PAN NUMBER', key: 'pan_number', width: 14 },
    { header: 'DATE OF JOINING', key: 'date_of_joining', width: 14 },
    { header: 'EMPLOYMENT TYPE', key: 'employment_type', width: 14 },
    { header: 'EMPLOYEE STATUS', key: 'status', width: 12 },
    { header: 'DESIGNATION', key: 'designation', width: 20 },
    { header: 'REPORTING TO', key: 'reporting_to_mobile', width: 18 },
    { header: 'WORK LOCATION', key: 'work_location', width: 24 },
    { header: 'ORG UNIT MAPPING', key: 'org_unit_mapping', width: 30 },
  ];
}

/** Fixed columns before dynamic level columns on Client List (for compliance start index). */
function clientListFixedColumnCount(_levelCount: number): number {
  return 6; // name, type, status, org unit mapping, pan, partner
}

/** 1-based column where org-section columns start on Employees sheet. */
function employeeOrgLevelStartCol(_levelCount: number): number {
  return 15; // after EMPLOYEE ID … WORK LOCATION (14 columns)
}

/**
 * Build Excel template workbook "OrgIt Master Bulk" — structure + assignments (no organisation legal profile).
 * Sheet order: Instructions, Organisation Structure, Service List, Client List, Employees, Tasks.
 */
export async function buildTemplateWorkbook(organizationId: string): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OrgIt Master Bulk';
  workbook.created = new Date();

  const tree = await loadTreeForBulk(organizationId);
  const levelsFromL2 = getActiveLevelsFromL2(tree);
  const complianceHeaders = await getRecurringTaskServiceTitles(organizationId);

  addInstructionsSheet(workbook, tree);
  addSectionEntityFieldReferenceSheet(workbook);
  addOrganisationStructureDataSheet(workbook, tree, tree.catalogLevels ?? tree.levels);

  const serviceListSheet = workbook.addWorksheet('Service List', {
    headerFooter: { firstHeader: 'OrgIt Master Bulk - Service List' },
  });
  serviceListSheet.columns = [
    { header: 'RECURRING TASK TITLE/SERVICE LIST', key: 'recurring_title', width: 35 },
    { header: 'FREQUENCY', key: 'frequency', width: 18 },
    { header: 'TASK ROLL OUT', key: 'rollout_rule', width: 28 },
    { header: 'ONE TIME TASK LIST', key: 'one_time_title', width: 30 },
  ];
  serviceListSheet.getRow(1).font = { bold: true };
  (serviceListSheet as any).dataValidations.add('B2:B1000', {
    type: 'list',
    allowBlank: true,
    formulae: [`"${TASK_FREQUENCIES.join(',')}"`],
    showErrorMessage: true,
    errorTitle: 'Invalid value',
    error: 'Select a value from the list (same as UI).',
  });
  const rolloutLabels = ['End of Period', '1 Month Before Period End'];
  (serviceListSheet as any).dataValidations.add('C2:C1000', {
    type: 'list',
    allowBlank: true,
    formulae: [`"${rolloutLabels.join(',')}"`],
    showErrorMessage: true,
    errorTitle: 'Invalid value',
    error: 'Select End of Period or 1 Month Before Period End.',
  });

  const clientListSheet = workbook.addWorksheet('Client List', {
    headerFooter: { firstHeader: 'OrgIt Master Bulk - Client List' },
  });
  const clientListCols = buildEntityListSheetColumns(complianceHeaders, tree);
  clientListSheet.columns = clientListCols;
  clientListSheet.getRow(1).font = { bold: true };
  const freqList = TASK_FREQUENCIES.join(',');
  const clientListLevelStartCol = 4;
  const clientListComplianceStartCol = clientListFixedColumnCount(levelsFromL2.length) + 1;
  for (let c = clientListComplianceStartCol; c <= clientListCols.length; c++) {
    const range = `${getExcelColLetter(c)}2:${getExcelColLetter(c)}1000`;
    (clientListSheet as any).dataValidations.add(range, {
      type: 'list',
      allowBlank: true,
      formulae: [`"${freqList}"`],
      showErrorMessage: true,
      errorTitle: 'Invalid value',
      error: 'Select a frequency from the list (same as UI).',
    });
  }

  const employeesSheet = workbook.addWorksheet('Employees', {
    headerFooter: { firstHeader: 'OrgIt Master Bulk - Employees' },
  });
  employeesSheet.columns = buildEmployeeSheetColumns(tree);
  employeesSheet.getRow(1).font = { bold: true };

  const tasksSheet = workbook.addWorksheet('Tasks', {
    headerFooter: { firstHeader: 'OrgIt Master Bulk - Tasks' },
  });
  tasksSheet.columns = [
    { header: 'Task Title', key: 'title', width: 35 },
    { header: 'Client Name', key: 'client_name', width: 28 },
    { header: 'Assigned To', key: 'assigned_to', width: 35, numFmt: '@' },
    { header: 'Reporting Member', key: 'reporting_member', width: 22, numFmt: '@' },
    { header: 'Start Date', key: 'start_date', width: 14 },
    { header: 'Target Date', key: 'target_date', width: 14 },
    { header: 'Due Date', key: 'due_date', width: 14 },
    { header: 'Task Type', key: 'task_type', width: 14 },
    { header: 'Recurrence', key: 'recurrence', width: 18 },
    { header: 'Task Owner', key: 'task_owner', width: 18, numFmt: '@' },
    { header: 'Financial Value', key: 'financial_value', width: 16 },
    { header: 'Description', key: 'description', width: 40 },
    { header: 'Auto Escalate', key: 'auto_escalate', width: 14 },
    { header: 'Tags', key: 'tags', width: 24 },
    { header: 'Task Roll Out', key: 'task_rollout_type', width: 20 },
    { header: 'Recurrence End Type', key: 'recurrence_end_type', width: 22 },
    { header: 'Recurrence End Date', key: 'recurrence_end_date', width: 20 },
    { header: 'Recurrence After Occurrences', key: 'recurrence_after_occurrences', width: 28 },
    { header: 'Escalation Trigger', key: 'escalation_trigger', width: 20 },
    { header: 'Escalation Days Before', key: 'escalation_days_before', width: 22 },
    { header: 'Escalation Contacts', key: 'escalation_contact_ids', width: 26 },
    { header: 'Compliance ID', key: 'compliance_id', width: 22 },
    { header: 'Document Instance ID', key: 'document_instance_id', width: 24 },
  ];
  tasksSheet.getRow(1).font = { bold: true };
  tasksSheet.getColumn(3).numFmt = '@';
  tasksSheet.getColumn(4).numFmt = '@';
  tasksSheet.getColumn(10).numFmt = '@';
  applyTaskBulkSheetValidations(tasksSheet);

  applyBulkTemplateEnhancements(workbook, tree, {
    entityListLevelStartCol: clientListLevelStartCol,
    employeesLevelStartCol: employeeOrgLevelStartCol(levelsFromL2.length),
  });

  const buffer = await workbook.xlsx.writeBuffer();
  console.log(
    '[EntityMasterTemplate] Built OrgIt Master Bulk workbook (Instructions, Structure, Service List, Client List, Employees, Tasks)'
  );
  return buffer as ExcelJS.Buffer;
}

const DEPRECATED_PARTIAL_TEMPLATE_MSG =
  'Partial Excel templates are no longer available. Download the master bulk workbook from Settings → Bulk upload (OrgIt_Master_Bulk.xlsx).';

/**
 * @deprecated Use buildTemplateWorkbook from Settings.
 */
export async function buildOrgStructureOnlyTemplate(_organizationId: string): Promise<ExcelJS.Buffer> {
  throw new Error(DEPRECATED_PARTIAL_TEMPLATE_MSG);
}

/**
 * @deprecated Organisation legal profile is web-only.
 */
export async function buildEntityMasterOnlyTemplate(): Promise<ExcelJS.Buffer> {
  throw new Error(DEPRECATED_PARTIAL_TEMPLATE_MSG);
}

/**
 * @deprecated Use buildTemplateWorkbook from Settings.
 */
export async function buildEmployeeOnlyTemplate(_organizationId: string): Promise<ExcelJS.Buffer> {
  throw new Error(DEPRECATED_PARTIAL_TEMPLATE_MSG);
}

/**
 * @deprecated Use buildTemplateWorkbook from Settings.
 */
export async function buildServiceListOnlyTemplate(): Promise<ExcelJS.Buffer> {
  throw new Error(DEPRECATED_PARTIAL_TEMPLATE_MSG);
}

/**
 * @deprecated Use buildTemplateWorkbook from Settings.
 */
export async function buildEntityListOnlyTemplate(_organizationId: string): Promise<ExcelJS.Buffer> {
  throw new Error(DEPRECATED_PARTIAL_TEMPLATE_MSG);
}

/** 1-based column index to Excel column letter (1=A, 2=B, ..., 27=AA). */
function getExcelColLetter(colIndex: number): string {
  let s = '';
  let n = colIndex;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || 'A';
}

/** colIndex is 1-based (from row.values / findIndex on header row). */
function getCellStr(row: ExcelJS.Row, colIndex: number): string {
  try {
    const cell = row.getCell(colIndex);
    const v = cell.value;
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'object' && v !== null && 'text' in v) return String((v as any).text).trim();
    if (typeof v === 'object' && v !== null && 'result' in v) return String((v as any).result ?? '').trim();
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).trim();
  } catch {
    return '';
  }
}

/** Get string and truncate to max length for DB safety */
function getCellStrMax(row: ExcelJS.Row, colIndex: number, maxLen: number = STRING_MAX): string {
  const s = getCellStr(row, colIndex);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/** colIndex is 1-based (from row.values / findIndex on header row). */
function getCellNum(row: ExcelJS.Row, colIndex: number): number | null {
  try {
    const cell = row.getCell(colIndex);
    const v = cell.value;
    if (v == null || v === '') return null;
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
    const n = Number(v);
    if (Number.isNaN(n)) return null;
    return n;
  } catch {
    return null;
  }
}

/** Return true if the row has no meaningful data in the given column indices (all empty/whitespace) */
function isRowEmpty(row: ExcelJS.Row, colIndices: number[]): boolean {
  for (const i of colIndices) {
    if (i < 0) continue;
    const s = getCellStr(row, i);
    if (s.length > 0) return false;
  }
  return true;
}

/** Normalize frequency to allowed enum (case-insensitive). */
function normalizeFrequency(s: string): string {
  const t = (s || '').trim();
  if (!t) return 'NA';
  const lower = t.toLowerCase();
  const found = TASK_FREQUENCIES.find((f) => f.toLowerCase() === lower);
  return found ?? 'NA';
}

/** Normalize rollout_rule to allowed enum (case-insensitive). Accepts UI labels: "End of Period", "1 Month Before Period End". */
function normalizeRolloutRule(s: string): string {
  const raw = (s || '').trim();
  if (!raw) return 'end_of_period';
  const t = raw.toLowerCase().replace(/\s+/g, '_');
  if (t.includes('one_month') || t.includes('before_period') || raw.toLowerCase().includes('1 month before')) return 'one_month_before_period_end';
  return 'end_of_period';
}

/** Normalize task_type to allowed enum (case-insensitive). */
function normalizeTaskType(s: string): string {
  const t = (s || '').trim().toLowerCase();
  if (t === 'one_time' || t === 'onetime') return 'one_time';
  if (t === 'recurring') return 'recurring';
  return '';
}

/**
 * Resolve country_id from country name or code. If not found, create the country and return new id (so upload works even when master data is not seeded).
 */
async function resolveOrCreateCountryId(client: any, nameOrCode: string): Promise<string | null> {
  const trimmed = (nameOrCode || '').trim();
  if (!trimmed) return null;
  let r = await client.query(
    'SELECT id FROM countries WHERE LOWER(TRIM(name)) = LOWER($1) OR LOWER(TRIM(code)) = LOWER($1) LIMIT 1',
    [trimmed]
  );
  if (r.rows.length > 0) return r.rows[0].id;
  const code = trimmed.length >= 2 ? trimmed.slice(0, 2).toUpperCase() : trimmed.toUpperCase();
  try {
    r = await client.query('INSERT INTO countries (name, code) VALUES ($1, $2) RETURNING id', [trimmed, code]);
    if (r.rows.length > 0) return r.rows[0].id;
  } catch {
    // Race: another request may have inserted; select again
  }
  r = await client.query('SELECT id FROM countries WHERE LOWER(TRIM(name)) = LOWER($1) LIMIT 1', [trimmed]);
  return r.rows.length > 0 ? r.rows[0].id : null;
}

/**
 * Resolve state_id by country_id and state name. If not found, create the state and return new id.
 */
async function resolveOrCreateStateId(client: any, countryId: string, stateName: string): Promise<string | null> {
  const trimmed = (stateName || '').trim();
  if (!trimmed || !countryId) return null;
  let r = await client.query(
    'SELECT id FROM states WHERE country_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
    [countryId, trimmed]
  );
  if (r.rows.length > 0) return r.rows[0].id;
  r = await client.query(
    'INSERT INTO states (country_id, name) VALUES ($1, $2) ON CONFLICT (country_id, name) DO NOTHING RETURNING id',
    [countryId, trimmed]
  );
  if (r.rows.length > 0) return r.rows[0].id;
  r = await client.query(
    'SELECT id FROM states WHERE country_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
    [countryId, trimmed]
  );
  return r.rows.length > 0 ? r.rows[0].id : null;
}

/**
 * Resolve city_id by state_id and city name. If not found, create the city and return new id.
 */
async function resolveOrCreateCityId(client: any, stateId: string, cityName: string): Promise<string | null> {
  const trimmed = (cityName || '').trim();
  if (!trimmed || !stateId) return null;
  let r = await client.query(
    'SELECT id FROM cities WHERE state_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
    [stateId, trimmed]
  );
  if (r.rows.length > 0) return r.rows[0].id;
  r = await client.query(
    'INSERT INTO cities (state_id, name) VALUES ($1, $2) ON CONFLICT (state_id, name) DO NOTHING RETURNING id',
    [stateId, trimmed]
  );
  if (r.rows.length > 0) return r.rows[0].id;
  r = await client.query(
    'SELECT id FROM cities WHERE state_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
    [stateId, trimmed]
  );
  return r.rows.length > 0 ? r.rows[0].id : null;
}

async function resolveOrganizationId(client: any, orgName: string): Promise<string | null> {
  if (!orgName) return null;
  const r = await client.query('SELECT id FROM organizations WHERE LOWER(TRIM(name)) = LOWER($1) LIMIT 1', [orgName]);
  return r.rows.length > 0 ? r.rows[0].id : null;
}

const orgNodesCacheForBulk = new Map<string, OrganizationStructureNode[]>();

export function invalidateOrgNodesCacheForBulk(organizationId: string): void {
  orgNodesCacheForBulk.delete(organizationId);
}

async function getOrgNodesForBulkResolve(organizationId: string): Promise<OrganizationStructureNode[]> {
  if (!orgNodesCacheForBulk.has(organizationId)) {
    const tree = await loadTreeForBulk(organizationId);
    orgNodesCacheForBulk.set(organizationId, tree.nodes || []);
  }
  return orgNodesCacheForBulk.get(organizationId)!;
}

async function resolveOrgStructureNodeId(client: any, organizationId: string, raw: string): Promise<string | null> {
  const nodes = await getOrgNodesForBulkResolve(organizationId);
  return resolveOrgStructureNodeFromHint(client, organizationId, raw, nodes);
}

async function orgPathJsonForNode(organizationId: string, nodeId: string): Promise<string | null> {
  try {
    const ref = await resolveNodeReference(organizationId, nodeId, { activeOnly: false });
    return ref.path?.length ? JSON.stringify(ref.path) : null;
  } catch {
    return null;
  }
}

async function orgNodeByLevelFromNodePath(organizationId: string, nodeId: string): Promise<OrgNodeByLevel> {
  try {
    const ref = await resolveNodeReference(organizationId, nodeId, { activeOnly: false });
    const out: OrgNodeByLevel = {};
    for (const p of ref.path || []) {
      if (p?.id && p?.levelLabel) {
        out[String(p.levelLabel).trim()] = String(p.id);
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function resolveOrgAssignmentForBulkRow(
  organizationId: string,
  row: ExcelJS.Row,
  headers: unknown[],
  levels: OrganizationStructureLevel[],
  resolveOrgNodeCached: (orgId: string, hint: string) => Promise<string | null>,
  explicitNodeColKeys: string[]
): Promise<{
  org_structure_node_id: string | null;
  org_structure_path: string | null;
  org_field_values: Record<string, unknown> | null;
}> {
  const levelsFromL2 = getActiveLevelsFromL2(levels);
  const levelCols = findLevelColumnIndices(headers, levels);
  let orgNodeByLevel: OrgNodeByLevel = await parseOrgNodeByLevelFromRow(row, levelCols, (raw) =>
    resolveOrgNodeCached(organizationId, raw)
  );
  let org_structure_node_id = getDeepestSelectedNodeId(orgNodeByLevel, levelsFromL2);
  const mappingIdx = colAny(headers, 'org unit mapping', 'org unit', 'org mapping');
  if (!org_structure_node_id && mappingIdx >= 0) {
    const mappingRaw = getCellStr(row, mappingIdx);
    if (mappingRaw?.trim()) {
      const mappedNode = await resolveOrgNodeCached(organizationId, mappingRaw);
      if (mappedNode) {
        org_structure_node_id = mappedNode;
      }
    }
  }
  const explicitIdx = colAny(headers, ...explicitNodeColKeys);
  if (explicitIdx >= 0) {
    const rawId = getCellStr(row, explicitIdx);
    if (rawId?.trim()) {
      const override = await resolveOrgNodeCached(organizationId, rawId);
      if (override) org_structure_node_id = override;
    }
  }
  if (org_structure_node_id && Object.keys(orgNodeByLevel).length === 0) {
    orgNodeByLevel = await orgNodeByLevelFromNodePath(organizationId, org_structure_node_id);
  }
  let org_structure_path: string | null = null;
  if (org_structure_node_id) {
    org_structure_path = await orgPathJsonForNode(organizationId, org_structure_node_id);
  }
  return {
    org_structure_node_id,
    org_structure_path,
    org_field_values: buildOrgFieldValuesPayload(orgNodeByLevel),
  };
}

async function resolveClientEntityId(client: any, organizationId: string, clientName: string): Promise<string | null> {
  if (!clientName || !organizationId) return null;
  const r = await client.query(
    'SELECT id FROM client_entities WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
    [organizationId, clientName]
  );
  return r.rows.length > 0 ? r.rows[0].id : null;
}

async function resolveTaskServiceId(client: any, organizationId: string | null, title: string, taskType: string): Promise<string | null> {
  if (!title || !taskType) return null;
  const r = await client.query(
    `SELECT id FROM task_services WHERE (organization_id IS NOT DISTINCT FROM $1)
     AND LOWER(TRIM(title)) = LOWER($2) AND task_type = $3 AND is_active = TRUE
     LIMIT 1`,
    [organizationId, title, taskType]
  );
  return r.rows.length > 0 ? r.rows[0].id : null;
}

async function resolveUserIdByMobile(client: any, mobile: string): Promise<string | null> {
  if (!mobile) return null;
  let normalized = mobile.trim().replace(/\s/g, '');
  if (!normalized) return null;
  // Normalize: accept 10 digits, 12 digits starting with 91, or +91XXXXXXXXXX
  if (normalized.startsWith('+')) {
    normalized = normalized.replace(/\D/g, '').replace(/^(\d+)$/, '+$1');
  } else {
    const digits = normalized.replace(/\D/g, '');
    if (digits.length === 10) {
      normalized = '+91' + digits;
    } else if (digits.length === 12 && digits.startsWith('91')) {
      normalized = '+' + digits;
    } else if (digits.length >= 6 && digits.length <= 20) {
      normalized = '+91' + digits.slice(-10); // Take last 10 digits if longer
    } else {
      return null; // Invalid format
    }
  }
  const r = await client.query(
    'SELECT id FROM users WHERE REPLACE(mobile, \' \', \'\') = $1 OR mobile = $1 LIMIT 1',
    [normalized]
  );
  return r.rows.length > 0 ? r.rows[0].id : null;
}

async function resolveReportingToByMobile(client: any, organizationId: string, reportingToMobile: string): Promise<string | null> {
  if (!reportingToMobile || !organizationId) return null;
  const userId = await resolveUserIdByMobile(client, reportingToMobile);
  if (!userId) return null;
  const r = await client.query(
    'SELECT user_id FROM user_organizations WHERE user_id = $1 AND organization_id = $2 LIMIT 1',
    [userId, organizationId]
  );
  return r.rows.length > 0 ? userId : null;
}

/** Resolve REPORTING TO by mobile or by name (manager in same org). Excel can have manager mobile or manager name. */
async function resolveReportingToByMobileOrName(client: any, organizationId: string, value: string): Promise<string | null> {
  if (!value || !organizationId) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Try as mobile first (value is mostly digits / +)
  const looksLikeMobile = /^[\d\s+\-]+$/.test(trimmed.replace(/\s/g, ''));
  if (looksLikeMobile) {
    const byMobile = await resolveReportingToByMobile(client, organizationId, trimmed);
    if (byMobile) return byMobile;
  }
  // Try as name: find user in same org whose name matches (case-insensitive)
  const r = await client.query(
    `SELECT uo.user_id FROM user_organizations uo
     JOIN users u ON u.id = uo.user_id
     WHERE uo.organization_id = $1 AND LOWER(TRIM(u.name)) = LOWER(TRIM($2))
     LIMIT 1`,
    [organizationId, trimmed]
  );
  return r.rows.length > 0 ? r.rows[0].user_id : null;
}

/** 1-based column index from header row (for getCell). */
function col(headers: any[], key: string): number {
  const i = headers.findIndex((h: any) => String(h ?? '').trim().toLowerCase() === key.toLowerCase());
  return i;
}
function colAny(headers: any[], ...keys: string[]): number {
  for (const key of keys) {
    const i = headers.findIndex((h: any) => String(h ?? '').trim().toLowerCase() === key.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}
function lastRow(sheet: ExcelJS.Worksheet): number {
  const effectiveRows = ((sheet as any).actualRowCount as number | undefined) ?? (sheet.rowCount ?? 0);
  return Math.min(effectiveRows, MAX_ROWS_PER_SHEET + 1);
}

/**
 * Parse uploaded workbook and apply updates. Uses transaction.
 * Admin: restricted to req.user.organizationId. Super_admin: can use organization_name to target orgs.
 */
export async function parseAndApply(
  fileBuffer: Buffer,
  userId: string,
  userOrganizationId: string | null,
  isSuperAdmin: boolean
): Promise<UploadResult> {
  const result: UploadResult = {
    updated: {
      organizations: 0,
      organization_structure_nodes: 0,
      task_services: 0,
      client_entities: 0,
      client_entity_services: 0,
      employees: 0,
    },
    errors: [],
  };

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as any);

  const deprecatedSheets = findDeprecatedSheets(workbook);
  if (deprecatedSheets.length > 0) {
    result.errors.push({
      message: `Unsupported sheet(s): ${deprecatedSheets.join(', ')}. Download the current OrgIt Settings template.`,
    });
    return result;
  }

  const sheetNames = workbook.worksheets.map((ws) => ws.name);
  console.log('[EntityMasterUpload] Workbook loaded', { sheetNames, rowCounts: workbook.worksheets.map((ws) => ({ name: ws.name, rows: ws.rowCount ?? 0 })) });

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Effective org for admin: always user's org. For super_admin we resolve per row when organization_name is present.
    const defaultOrgId = userOrganizationId || null;
    console.log('[EntityMasterUpload] defaultOrgId', defaultOrgId);

    // Bulk: cap reported errors and push with sheet/row context
    const pushError = (err: { sheet?: string; row?: number; message: string }) => {
      if (result.errors.length >= MAX_ERRORS_REPORTED) return;
      result.errors.push(err);
      if (result.errors.length === MAX_ERRORS_REPORTED)
        result.errors.push({ message: `Too many errors; only first ${MAX_ERRORS_REPORTED} reported. Fix reported rows and re-upload.` });
    };

    // Bulk: caches for repeated lookups in same upload
    const orgIdCache = new Map<string, string>();
    const orgNodeCache = new Map<string, string>();
    const clientEntityCache = new Map<string, string>();
    const taskServiceCache = new Map<string, string>();
    const resolveOrgIdCached = async (name: string): Promise<string | null> => {
      const key = (name || '').trim().toLowerCase();
      if (!key) return null;
      if (orgIdCache.has(key)) return orgIdCache.get(key)!;
      const id = await resolveOrganizationId(client, name);
      if (id) orgIdCache.set(key, id);
      return id;
    };
    const resolveOrgNodeCached = async (organizationId: string, hint: string): Promise<string | null> => {
      const key = `node|${organizationId}|${(hint || '').trim().toLowerCase()}`;
      if (!hint?.trim()) return null;
      if (orgNodeCache.has(key)) return orgNodeCache.get(key)!;
      const id = await resolveOrgStructureNodeId(client, organizationId, hint);
      if (id) orgNodeCache.set(key, id);
      return id;
    };
    const resolveClientEntityCached = async (organizationId: string, clientName: string): Promise<string | null> => {
      const key = `${organizationId}|${(clientName || '').trim().toLowerCase()}`;
      if (!clientName?.trim()) return null;
      if (clientEntityCache.has(key)) return clientEntityCache.get(key)!;
      const id = await resolveClientEntityId(client, organizationId, clientName);
      if (id) clientEntityCache.set(key, id);
      return id;
    };
    const resolveTaskServiceCached = async (organizationId: string | null, title: string, taskType: string): Promise<string | null> => {
      const key = `${organizationId ?? ''}|${(title || '').trim().toLowerCase()}|${taskType}`;
      if (!title?.trim() || !taskType) return null;
      if (taskServiceCache.has(key)) return taskServiceCache.get(key)!;
      const id = await resolveTaskServiceId(client, organizationId, title, taskType);
      if (id) taskServiceCache.set(key, id);
      return id;
    };

    // Helper: get column index by header name (0-based for getCellStr)
    const col = (headers: any[], key: string): number => {
      const i = headers.findIndex((h: any) => String(h || '').trim().toLowerCase() === key.toLowerCase());
      return i;
    };
    // Resolve column by any of several header names (e.g. new template vs old)
    const colAny = (headers: any[], ...keys: string[]): number => {
      for (const key of keys) {
        const i = headers.findIndex((h: any) => String(h || '').trim().toLowerCase() === key.toLowerCase());
        if (i >= 0) return i;
      }
      return -1;
    };
    const getSheet = (names: string[]): ExcelJS.Worksheet | undefined => {
      for (const n of names) {
        const w = workbook.getWorksheet(n);
        if (w) return w;
      }
      return undefined;
    };

    const lastRow = (sheet: ExcelJS.Worksheet) => {
      const effectiveRows = ((sheet as any).actualRowCount as number | undefined) ?? (sheet.rowCount ?? 0);
      return Math.min(effectiveRows, MAX_ROWS_PER_SHEET + 1);
    };
    const hasMoreThanMaxRows = (sheet: ExcelJS.Worksheet) => {
      const effectiveRows = ((sheet as any).actualRowCount as number | undefined) ?? (sheet.rowCount ?? 0);
      return effectiveRows > MAX_ROWS_PER_SHEET + 1;
    };

    // --- Organisation profile: only when "Entity Master Data (Org)" is uploaded without structure/assignment sheets
    // (Admin → Entity Master). OrgIt Settings workbook is structure + assignments only.
    const orgSheet = getSheet([
      'Entity Master Data (Org)',
      'Entity Master (Organisation)',
      'ENTITY MASTER DATA (Organisati',
      'ENTITY MASTER DATA (Organisation)',
      'Organizations',
    ]);
    const workbookHasStructureOrAssignmentSheet = workbook.worksheets.some((ws) =>
      [
        'Organisation Structure',
        'Client List',
        'Entity List',
        'Client Entities',
        'Client entities',
        'Service List',
        'Tasks',
        'Employees',
      ].includes(ws.name)
    );
    const skipOrgProfileParse = Boolean(orgSheet && workbookHasStructureOrAssignmentSheet);
    if (skipOrgProfileParse) {
      pushError({
        message:
          'Organisation profile sheet cannot be merged with OrgIt Settings (structure / Entity List / Service List / Tasks / Employees). Remove "Entity Master Data (Org)", or upload it alone from Admin → Entity Master.',
      });
    }

    console.log('[EntityMasterUpload] Organisation sheet', orgSheet ? { name: orgSheet.name, rowCount: orgSheet.rowCount } : 'NOT FOUND');
    if (!skipOrgProfileParse && orgSheet && orgSheet.rowCount >= 1) {
      const firstRow = orgSheet.getRow(1);
      const a1 = String((firstRow.getCell(1).value ?? '')).trim().toLowerCase();
      const isVerticalLayout = a1 === 'name of the organisation' || a1.startsWith('short name');

      if (isVerticalLayout) {
        // Vertical layout: column A = field labels, column B = values (one org per sheet)
        const vals: Record<string, string | number | null> = {};
        const maxRows = Math.min(orgSheet.rowCount ?? 0, ENTITY_MASTER_VERTICAL_FIELDS.length);
        for (let r = 1; r <= maxRows; r++) {
          const row = orgSheet.getRow(r);
          const label = String((row.getCell(1).value ?? '')).trim().toLowerCase();
          const cellBStr = getCellStr(row, 2);
          const field = ENTITY_MASTER_VERTICAL_FIELDS.find((f) => f.label.trim().toLowerCase() === label);
          const key = field?.key ?? ENTITY_MASTER_LEGACY_LABELS[label];
          if (key && !key.startsWith('_')) {
            vals[key] = cellBStr === '' ? '' : cellBStr;
          }
        }
        const name = (vals.name != null && vals.name !== '') ? String(vals.name).slice(0, NAME_MAX) : '';

        // If all collected values are effectively empty, treat the sheet as "not filled"
        // so that uploading a workbook with only the Tasks sheet filled does not error.
        const hasAnyOrgValue = Object.values(vals).some(
          (v) => v !== null && v !== undefined && String(v).trim() !== ''
        );

        if (!hasAnyOrgValue) {
          console.log('[EntityMasterUpload] Organisation vertical sheet present but empty – skipping without error');
        } else if (!name) {
          pushError({ sheet: orgSheet.name, message: 'Vertical layout: "Name of the Organisation" (row 1) is required' });
        } else {
          let orgId: string | null;
          if (isSuperAdmin) {
            orgId = await resolveOrgIdCached(name);
            if (!orgId) {
              pushError({ sheet: orgSheet.name, message: `Organization not found: ${name}` });
            } else {
              try {
                const short_name = (vals.short_name != null && vals.short_name !== '') ? String(vals.short_name).slice(0, NAME_MAX) : '';
                const address = (vals.address != null && vals.address !== '') ? String(vals.address).slice(0, STRING_MAX) : '';
                const email = (vals.email != null && vals.email !== '') ? String(vals.email).slice(0, NAME_MAX) : '';
                const website = (vals.website != null && vals.website !== '') ? String(vals.website) : '';
                const phone_number = (vals.phone_number != null && vals.phone_number !== '') ? String(vals.phone_number).slice(0, PHONE_PIN_MAX) : '';
                let org_constitution = (vals.org_constitution != null && vals.org_constitution !== '') ? String(vals.org_constitution) : '';
                if (['NIL', 'NA', 'N/A', 'NULL', '-', ''].includes((org_constitution || '').trim().toUpperCase())) org_constitution = '';
                if (org_constitution && !ORG_CONSTITUTION_VALUES.includes(org_constitution)) {
                  const byLabel = ORG_CONSTITUTION_OPTIONS.find((o) => o.label.toLowerCase().trim() === org_constitution!.toLowerCase().trim());
                  if (byLabel) org_constitution = byLabel.value;
                  else org_constitution = '';
                }
                const pan = (vals.pan != null && vals.pan !== '') ? String(vals.pan) : '';
                const gst = (vals.gst != null && vals.gst !== '') ? String(vals.gst) : '';
                const cin = (vals.cin != null && vals.cin !== '') ? String(vals.cin).slice(0, NAME_MAX) : '';
                const country_name = (vals.country_name != null && vals.country_name !== '') ? String(vals.country_name).trim() : '';
                const state_name = (vals.state_name != null && vals.state_name !== '') ? String(vals.state_name).trim() : '';
                const city_name = (vals.city_name != null && vals.city_name !== '') ? String(vals.city_name).trim() : '';
                const pin_code = (vals.pin_code != null && vals.pin_code !== '') ? String(vals.pin_code).slice(0, PHONE_PIN_MAX) : '';
                const address_line1 = (vals.address_line1 != null && vals.address_line1 !== '') ? String(vals.address_line1).slice(0, STRING_MAX) : '';
                const address_line2 = (vals.address_line2 != null && vals.address_line2 !== '') ? String(vals.address_line2).slice(0, STRING_MAX) : '';
                let country_id: string | null = null;
                let state_id: string | null = null;
                let city_id: string | null = null;
                if (country_name) {
                  country_id = await resolveOrCreateCountryId(client, country_name);
                  if (state_name && country_id) state_id = await resolveOrCreateStateId(client, country_id, state_name);
                  if (city_name && state_id) city_id = await resolveOrCreateCityId(client, state_id, city_name);
                }
                await client.query(
                  `UPDATE organizations SET
                  name = $1, short_name = $2, address = NULLIF($3,''), email = $4, website = $5, phone_number = $6,
                  org_constitution = NULLIF($7,''), pan = $8, gst = $9, cin = NULLIF($10,''),
                  country_id = $11, state_id = $12, city_id = $13, pin_code = NULLIF($14,''), address_line1 = NULLIF($15,''), address_line2 = NULLIF($16,''),
                  updated_at = CURRENT_TIMESTAMP
                  WHERE id = $17`,
                  [name, short_name || null, address || null, email || null, website || null, phone_number || null, org_constitution || null, pan || null, gst || null, cin || null, country_id, state_id, city_id, pin_code || null, address_line1 || null, address_line2 || null, orgId]
                );
                result.updated.organizations += 1;
                console.log('[EntityMasterUpload] Organisation (vertical) updated', { sheet: orgSheet.name, orgId, name });
              } catch (err: any) {
                pushError({ sheet: orgSheet.name, message: err?.message ?? String(err) });
              }
            }
          } else {
            orgId = defaultOrgId;
            if (!orgId) {
              pushError({ sheet: orgSheet.name, message: 'Admin must have an organization' });
            } else {
              try {
                const short_name = (vals.short_name != null && vals.short_name !== '') ? String(vals.short_name).slice(0, NAME_MAX) : '';
                const address = (vals.address != null && vals.address !== '') ? String(vals.address).slice(0, STRING_MAX) : '';
                const email = (vals.email != null && vals.email !== '') ? String(vals.email).slice(0, NAME_MAX) : '';
                const website = (vals.website != null && vals.website !== '') ? String(vals.website) : '';
                const phone_number = (vals.phone_number != null && vals.phone_number !== '') ? String(vals.phone_number).slice(0, PHONE_PIN_MAX) : '';
                let org_constitution = (vals.org_constitution != null && vals.org_constitution !== '') ? String(vals.org_constitution) : '';
                if (['NIL', 'NA', 'N/A', 'NULL', '-', ''].includes((org_constitution || '').trim().toUpperCase())) org_constitution = '';
                if (org_constitution && !ORG_CONSTITUTION_VALUES.includes(org_constitution)) {
                  const byLabel = ORG_CONSTITUTION_OPTIONS.find((o) => o.label.toLowerCase().trim() === org_constitution!.toLowerCase().trim());
                  if (byLabel) org_constitution = byLabel.value;
                  else org_constitution = '';
                }
                const pan = (vals.pan != null && vals.pan !== '') ? String(vals.pan) : '';
                const gst = (vals.gst != null && vals.gst !== '') ? String(vals.gst) : '';
                const cin = (vals.cin != null && vals.cin !== '') ? String(vals.cin).slice(0, NAME_MAX) : '';
                const country_name = (vals.country_name != null && vals.country_name !== '') ? String(vals.country_name).trim() : '';
                const state_name = (vals.state_name != null && vals.state_name !== '') ? String(vals.state_name).trim() : '';
                const city_name = (vals.city_name != null && vals.city_name !== '') ? String(vals.city_name).trim() : '';
                const pin_code = (vals.pin_code != null && vals.pin_code !== '') ? String(vals.pin_code).slice(0, PHONE_PIN_MAX) : '';
                const address_line1 = (vals.address_line1 != null && vals.address_line1 !== '') ? String(vals.address_line1).slice(0, STRING_MAX) : '';
                const address_line2 = (vals.address_line2 != null && vals.address_line2 !== '') ? String(vals.address_line2).slice(0, STRING_MAX) : '';
                let country_id: string | null = null;
                let state_id: string | null = null;
                let city_id: string | null = null;
                if (country_name) {
                  country_id = await resolveOrCreateCountryId(client, country_name);
                  if (state_name && country_id) state_id = await resolveOrCreateStateId(client, country_id, state_name);
                  if (city_name && state_id) city_id = await resolveOrCreateCityId(client, state_id, city_name);
                }
                await client.query(
                  `UPDATE organizations SET
                  name = $1, short_name = $2, address = NULLIF($3,''), email = $4, website = $5, phone_number = $6,
                  org_constitution = NULLIF($7,''), pan = $8, gst = $9, cin = NULLIF($10,''),
                  country_id = $11, state_id = $12, city_id = $13, pin_code = NULLIF($14,''), address_line1 = NULLIF($15,''), address_line2 = NULLIF($16,''),
                  updated_at = CURRENT_TIMESTAMP
                  WHERE id = $17`,
                  [name, short_name || null, address || null, email || null, website || null, phone_number || null, org_constitution || null, pan || null, gst || null, cin || null, country_id, state_id, city_id, pin_code || null, address_line1 || null, address_line2 || null, orgId]
                );
                result.updated.organizations += 1;
                console.log('[EntityMasterUpload] Organisation (vertical) updated', { sheet: orgSheet.name, orgId, name });
              } catch (err: any) {
                pushError({ sheet: orgSheet.name, message: err?.message ?? String(err) });
              }
            }
          }
        }
        console.log('[EntityMasterUpload] Organisation processed (vertical)', { updated: result.updated.organizations });
      } else {
        // Horizontal layout: row 1 = headers, row 2+ = data
        const headers = orgSheet.getRow(1).values as any[];
        const nameCol = colAny(headers, 'name', 'name of the organisation');
        if (nameCol < 0) {
          pushError({ sheet: orgSheet.name, message: 'Missing column: Name of the Organisation or name' });
        } else if (orgSheet.rowCount >= 2) {
          const maxRow = lastRow(orgSheet);
          if (hasMoreThanMaxRows(orgSheet))
            pushError({ sheet: orgSheet.name, message: `Sheet has more than ${MAX_ROWS_PER_SHEET} rows; only first ${MAX_ROWS_PER_SHEET} processed.` });
          const shortNameCol = colAny(headers, 'short_name', 'short name');
          const addressCol = colAny(headers, 'address', 'address of the organisation');
          const emailCol = colAny(headers, 'email', 'e mail id');
          const websiteCol = colAny(headers, 'website', 'web site');
          const phoneNumberCol = colAny(headers, 'phone_number', 'phone number');
          const orgConstitutionCol = colAny(headers, 'org_constitution', 'org constitution', 'entity type');
          const panCol = colAny(headers, 'pan', 'pan of the organisation', 'pan of the entity');
          const gstCol = colAny(headers, 'gst', 'gst number');
          const cinCol = colAny(headers, 'cin number', 'cin', 'registration number of the entity');
          const countryNameCol = colAny(headers, 'country_name', 'country');
          const stateNameCol = colAny(headers, 'state_name', 'state');
          const cityNameCol = colAny(headers, 'city_name', 'city');
          const pinCodeCol = colAny(headers, 'pin_code', 'pin code');
          const addressLine1Col = colAny(headers, 'address_line1', 'address line 1');
          const addressLine2Col = colAny(headers, 'address_line2', 'address line 2');
          const orgNameCol = col(headers, 'organization_name');
          for (let r = 2; r <= maxRow; r++) {
            try {
              const row = orgSheet.getRow(r);
              if (isRowEmpty(row, [nameCol])) continue;
              const name = getCellStrMax(row, nameCol, NAME_MAX);
              if (!name) continue;
              let orgId: string | null;
              if (isSuperAdmin) {
                const orgName = orgNameCol >= 0 ? getCellStr(row, orgNameCol) : '';
                orgId = orgName ? await resolveOrgIdCached(orgName) : null;
                if (!orgId && orgName) {
                  pushError({ sheet: orgSheet.name, row: r, message: `Organization not found: ${orgName}` });
                  continue;
                }
                if (!orgId) continue;
              } else {
                orgId = defaultOrgId;
                if (!orgId) {
                  pushError({ sheet: orgSheet.name, row: r, message: 'Admin must have an organization' });
                  continue;
                }
              }
              const short_name = shortNameCol >= 0 ? getCellStrMax(row, shortNameCol, NAME_MAX) : '';
              const address = addressCol >= 0 ? getCellStrMax(row, addressCol, STRING_MAX) : '';
              const email = emailCol >= 0 ? getCellStrMax(row, emailCol, NAME_MAX) : '';
              const website = websiteCol >= 0 ? getCellStr(row, websiteCol) : '';
              const phone_number = phoneNumberCol >= 0 ? getCellStrMax(row, phoneNumberCol, PHONE_PIN_MAX) : '';
              let org_constitution = orgConstitutionCol >= 0 ? getCellStr(row, orgConstitutionCol) : '';
              if (['NIL', 'NA', 'N/A', 'NULL', '-', ''].includes((org_constitution || '').trim().toUpperCase())) org_constitution = '';
              if (org_constitution && !ORG_CONSTITUTION_VALUES.includes(org_constitution)) {
                const byLabel = ORG_CONSTITUTION_OPTIONS.find((o) => o.label.toLowerCase().trim() === org_constitution!.toLowerCase().trim());
                if (byLabel) org_constitution = byLabel.value;
                else {
                  console.log('[EntityMasterUpload] org_constitution invalid, treating as empty', { row: r, value: org_constitution });
                  org_constitution = '';
                }
              }
              const pan = panCol >= 0 ? getCellStr(row, panCol) : '';
              const gst = gstCol >= 0 ? getCellStr(row, gstCol) : '';
              const cin = cinCol >= 0 ? getCellStrMax(row, cinCol, NAME_MAX) : '';
              const country_name = (countryNameCol >= 0 ? getCellStr(row, countryNameCol) : '').trim();
              const state_name = (stateNameCol >= 0 ? getCellStr(row, stateNameCol) : '').trim();
              const city_name = (cityNameCol >= 0 ? getCellStr(row, cityNameCol) : '').trim();
              const pin_code = pinCodeCol >= 0 ? getCellStrMax(row, pinCodeCol, PHONE_PIN_MAX) : '';
              const address_line1 = addressLine1Col >= 0 ? getCellStrMax(row, addressLine1Col, STRING_MAX) : '';
              const address_line2 = addressLine2Col >= 0 ? getCellStrMax(row, addressLine2Col, STRING_MAX) : '';

              let country_id: string | null = null;
              let state_id: string | null = null;
              let city_id: string | null = null;
              if (country_name) {
                country_id = await resolveOrCreateCountryId(client, country_name);
                if (state_name && country_id) state_id = await resolveOrCreateStateId(client, country_id, state_name);
                if (city_name && state_id) city_id = await resolveOrCreateCityId(client, state_id, city_name);
              }

              await client.query(
                `UPDATE organizations SET
                name = $1, short_name = $2, address = NULLIF($3,''), email = $4, website = $5, phone_number = $6,
                org_constitution = NULLIF($7,''), pan = $8, gst = $9, cin = NULLIF($10,''),
                country_id = $11, state_id = $12, city_id = $13, pin_code = NULLIF($14,''), address_line1 = NULLIF($15,''), address_line2 = NULLIF($16,''),
                updated_at = CURRENT_TIMESTAMP
                WHERE id = $17`,
                [name, short_name || null, address || null, email || null, website || null, phone_number || null, org_constitution || null, pan || null, gst || null, cin || null, country_id, state_id, city_id, pin_code || null, address_line1 || null, address_line2 || null, orgId]
              );
              result.updated.organizations += 1;
              console.log('[EntityMasterUpload] Organisation row updated', { sheet: orgSheet.name, row: r, orgId, name });
            } catch (err: any) {
              pushError({ sheet: orgSheet.name, row: r, message: err?.message ?? String(err) });
            }
          }
          console.log('[EntityMasterUpload] Organisation processed', { updated: result.updated.organizations });
        }
      }
    } else if (!skipOrgProfileParse && !orgSheet) {
      console.log(
        '[EntityMasterUpload] No organisation-profile sheet present (structure + assignments only for full settings template)'
      );
    }

    // --- Organisation Structure (before Entity List / Employees) ---
    const structureSheet = workbook.getWorksheet('Organisation Structure');
    console.log(
      '[EntityMasterUpload] Organisation Structure sheet',
      structureSheet ? { name: structureSheet.name, rowCount: structureSheet.rowCount } : 'NOT FOUND (optional)'
    );
    if (structureSheet && (structureSheet.rowCount ?? 0) >= 2 && defaultOrgId) {
      result.updated.organization_structure_nodes = await parseOrganizationStructureSheet(
        structureSheet,
        client,
        defaultOrgId,
        userId,
        pushError
      );
      if (result.updated.organization_structure_nodes > 0) {
        invalidateOrgNodesCacheForBulk(defaultOrgId);
      }
      console.log('[EntityMasterUpload] Organisation Structure processed', {
        updated: result.updated.organization_structure_nodes,
      });
    }

    // --- Service List (task_services); optional – skip if sheet missing ---
    // Accepts: RECURRING TASK TITLE/SERVICE LIST, FREQUENCY, TASK ROLL OUT, ONE TIME TASK LIST (or legacy title, task_type, frequency, rollout_rule, is_active)
    const serviceListSheet = workbook.getWorksheet('Service List');
    console.log('[EntityMasterUpload] Service List sheet', serviceListSheet ? { name: serviceListSheet.name, rowCount: serviceListSheet.rowCount } : 'NOT FOUND (optional)');
    if (serviceListSheet && serviceListSheet.rowCount >= 2) {
      const headers = serviceListSheet.getRow(1).values as any[];
      const orgNameIdx = colAny(headers, 'organization_name');
      const recurringTitleIdx = colAny(headers, 'recurring task title/service list', 'recurring title', 'title');
      const freqIdx = colAny(headers, 'frequency');
      const rolloutIdx = colAny(headers, 'task roll out', 'rollout_rule');
      const oneTimeTitleIdx = colAny(headers, 'one time task list', 'one_time title');
      const taskTypeIdx = col(headers, 'task_type');
      const isActiveIdx = col(headers, 'is_active');

      const processTaskRow = async (orgId: string | null, title: string, task_type: string, frequency: string, rollout_rule: string, is_active: boolean, r: number) => {
        if (!orgId || !title || !task_type) return;
        const freqNorm = normalizeFrequency(frequency);
        const rollNorm = normalizeRolloutRule(rollout_rule);
        if (!TASK_TYPES.includes(task_type)) {
          pushError({ sheet: 'Service List', row: r, message: `Invalid task_type: ${task_type}` });
          return;
        }
        const titleSafe = title.trim().slice(0, TITLE_MAX);
        const existing = await client.query(
          `SELECT id FROM task_services WHERE (organization_id IS NOT DISTINCT FROM $1) AND LOWER(TRIM(title)) = LOWER($2) AND task_type = $3 LIMIT 1`,
          [orgId, titleSafe, task_type]
        );
        if (existing.rows.length > 0) {
          await client.query(
            'UPDATE task_services SET frequency = $1, rollout_rule = $2, is_active = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
            [freqNorm, rollNorm, is_active, existing.rows[0].id]
          );
        } else {
          await client.query(
            'INSERT INTO task_services (organization_id, title, task_type, frequency, rollout_rule, is_active) VALUES ($1, $2, $3, $4, $5, $6)',
            [orgId, titleSafe, task_type, freqNorm, rollNorm, is_active]
          );
        }
        result.updated.task_services += 1;
      };

      const maxRow = lastRow(serviceListSheet);
      if (hasMoreThanMaxRows(serviceListSheet))
        pushError({ sheet: 'Service List', message: `Sheet has more than ${MAX_ROWS_PER_SHEET} rows; only first ${MAX_ROWS_PER_SHEET} processed.` });
      for (let r = 2; r <= maxRow; r++) {
        try {
          const row = serviceListSheet.getRow(r);
          let orgId = defaultOrgId;
          if (isSuperAdmin && orgNameIdx >= 0) {
            const on = getCellStr(row, orgNameIdx);
            if (on) orgId = await resolveOrgIdCached(on);
          }
          if (!orgId) continue;

          // New format: RECURRING TASK TITLE/SERVICE LIST + FREQUENCY + TASK ROLL OUT, and ONE TIME TASK LIST
          if (recurringTitleIdx >= 0 || oneTimeTitleIdx >= 0) {
            const recurringTitle = recurringTitleIdx >= 0 ? getCellStrMax(row, recurringTitleIdx, TITLE_MAX) : '';
            const oneTimeTitle = oneTimeTitleIdx >= 0 ? getCellStrMax(row, oneTimeTitleIdx, TITLE_MAX) : '';
            const titleIndices = [recurringTitleIdx, oneTimeTitleIdx].filter((i) => i >= 0);
            if (titleIndices.length > 0 && isRowEmpty(row, titleIndices)) continue;
            const frequency = freqIdx >= 0 ? getCellStr(row, freqIdx) || 'NA' : 'NA';
            const rollout_rule = rolloutIdx >= 0 ? getCellStr(row, rolloutIdx) : 'end_of_period';
            if (recurringTitle) await processTaskRow(orgId, recurringTitle, 'recurring', frequency, rollout_rule, true, r);
            if (oneTimeTitle) await processTaskRow(orgId, oneTimeTitle, 'one_time', 'NA', 'end_of_period', true, r);
            continue;
          }

          // Legacy format: title + task_type columns
          if (taskTypeIdx >= 0) {
            const titleIdx = col(headers, 'title');
            if (titleIdx < 0) continue;
            const title = getCellStrMax(row, titleIdx, TITLE_MAX);
            const task_type_raw = normalizeTaskType(getCellStr(row, taskTypeIdx));
            if (!title || !task_type_raw) continue;
            const frequency = freqIdx >= 0 ? getCellStr(row, freqIdx) || 'NA' : 'NA';
            const rollout_rule = rolloutIdx >= 0 ? getCellStr(row, rolloutIdx) : 'end_of_period';
            let is_active = true;
            if (isActiveIdx >= 0) {
              const v = String(getCellStr(row, isActiveIdx)).toLowerCase();
              is_active = v !== 'false' && v !== '0' && v !== 'no';
            }
            await processTaskRow(orgId, title, task_type_raw, frequency, rollout_rule, is_active, r);
          }
        } catch (err: any) {
          pushError({ sheet: 'Service List', row: r, message: err?.message ?? String(err) });
        }
      }
      console.log('[EntityMasterUpload] Service List processed', { updated: result.updated.task_services });
    }

    // --- Client entities / Entity List (Entity List, Client Entities or legacy Client entities) ---
    const clientSheet = getSheet(['Client List', 'Entity List', 'Client Entities', 'Client entities']);
    console.log('[EntityMasterUpload] Client List / Entity List sheet', clientSheet ? { name: clientSheet.name, rowCount: clientSheet.rowCount } : 'NOT FOUND');
    if (clientSheet && clientSheet.rowCount >= 2) {
      const headers = clientSheet.getRow(1).values as any[];
      const nameIdx = colAny(headers, 'name', 'name of the client');
      const orgNameIdx = colAny(headers, 'organization_name');
      const entityTypeIdx = colAny(headers, 'entity_type', 'entity type');
      const statusIdx = colAny(headers, 'status');
      const legacyCols = findLegacyEntityListColumns(headers);
      const panIdx = colAny(headers, 'pan');
      const reportingPartnerIdx = colAny(headers, 'reporting_partner_mobile', 'reporting partner', 'reporting_partner');
      const clientEntityStatusColumn = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'client_entities' AND column_name = 'status'`
      );
      const hasClientEntityStatus = clientEntityStatusColumn.rows.length > 0;
      const clientOrgFieldValuesColumn = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'client_entities' AND column_name = 'org_field_values'`
      );
      const hasClientOrgFieldValues = clientOrgFieldValuesColumn.rows.length > 0;
      const normalizeClientEntityStatus = (raw: string): string | null => {
        const v = (raw || '').trim().toLowerCase();
        if (!v) return null;
        if (v === 'active' || v === 'inactive') return v;
        if (v === '1' || v === 'true' || v === 'yes') return 'active';
        if (v === '0' || v === 'false' || v === 'no') return 'inactive';
        return null;
      };
      // Compliance columns: header (trimmed) -> { colIndex, taskServiceTitle } from task_services (recurring) only
      const allowedTitles = await getRecurringTaskServiceTitlesForEntityList(defaultOrgId, client);
      const complianceCols: Array<{ colIndex: number; taskServiceTitle: string }> = [];
      for (let i = 1; i < (headers?.length ?? 0); i++) {
        const h = String(headers[i] ?? '').trim();
        if (!h) continue;
        const match = allowedTitles.find((t) => t.toLowerCase() === h.toLowerCase());
        if (match) complianceCols.push({ colIndex: i, taskServiceTitle: match });
      }
      if (legacyCols.length > 0) {
        pushError({
          sheet: clientSheet.name,
          message: `Unsupported column(s): ${legacyCols.join(', ')}. Use per-level columns from the current template.`,
        });
      } else if (nameIdx >= 0) {
        const maxRow = lastRow(clientSheet);
        if (hasMoreThanMaxRows(clientSheet))
          pushError({ sheet: clientSheet.name, message: `Sheet has more than ${MAX_ROWS_PER_SHEET} rows; only first ${MAX_ROWS_PER_SHEET} processed.` });
        for (let r = 2; r <= maxRow; r++) {
          try {
            const row = clientSheet.getRow(r);
            if (isRowEmpty(row, [nameIdx])) continue;
            const name = getCellStrMax(row, nameIdx, NAME_MAX);
            if (!name) continue;
            let orgId = defaultOrgId;
            if (isSuperAdmin && orgNameIdx >= 0) {
              const on = getCellStr(row, orgNameIdx);
              if (on) orgId = await resolveOrgIdCached(on);
            }
            if (!orgId) continue;
            const entity_type = entityTypeIdx >= 0 ? getCellStrMax(row, entityTypeIdx, NAME_MAX) : '';
            const statusRaw = statusIdx >= 0 ? getCellStr(row, statusIdx) : '';
            const status = normalizeClientEntityStatus(statusRaw);
            if (statusRaw && !status) {
              pushError({ sheet: clientSheet.name, row: r, message: `Invalid status: ${statusRaw}. Use Active or Inactive.` });
              continue;
            }
            const pan = panIdx >= 0 ? getCellStrMax(row, panIdx, 50) : '';
            const reporting_partner_mobile = reportingPartnerIdx >= 0 ? getCellStrMax(row, reportingPartnerIdx, PHONE_PIN_MAX) : '';
            const structureLevels = await loadOrganizationStructureLevels(client, orgId);
            const assignment = await resolveOrgAssignmentForBulkRow(
              orgId,
              row,
              headers,
              structureLevels,
              resolveOrgNodeCached,
              [
                'org_structure_node_id',
                'org structure node id',
                'org node id',
                'organization node id',
                'org unit id',
                'organization unit id',
              ]
            );
            const orgStructureNodeId = assignment.org_structure_node_id;
            const orgStructurePathJson = assignment.org_structure_path;
            const orgFieldValuesJson = JSON.stringify(assignment.org_field_values ?? {});
            const existing = await client.query(
              'SELECT id FROM client_entities WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
              [orgId, name]
            );
            if (existing.rows.length > 0) {
              if (hasClientEntityStatus && hasClientOrgFieldValues) {
                await client.query(
                  "UPDATE client_entities SET entity_type = NULLIF($1, ''), status = COALESCE($2, status), org_structure_node_id = $3, org_structure_path = $4::jsonb, org_field_values = COALESCE($5::jsonb, org_field_values), pan = NULLIF($6, ''), reporting_partner_mobile = NULLIF($7, ''), updated_at = CURRENT_TIMESTAMP WHERE id = $8",
                  [
                    entity_type || null,
                    status,
                    orgStructureNodeId,
                    orgStructurePathJson,
                    orgFieldValuesJson,
                    pan || null,
                    reporting_partner_mobile || null,
                    existing.rows[0].id,
                  ]
                );
              } else if (hasClientEntityStatus) {
                await client.query(
                  "UPDATE client_entities SET entity_type = NULLIF($1, ''), status = COALESCE($2, status), org_structure_node_id = $3, org_structure_path = $4::jsonb, pan = NULLIF($5, ''), reporting_partner_mobile = NULLIF($6, ''), updated_at = CURRENT_TIMESTAMP WHERE id = $7",
                  [
                    entity_type || null,
                    status,
                    orgStructureNodeId,
                    orgStructurePathJson,
                    pan || null,
                    reporting_partner_mobile || null,
                    existing.rows[0].id,
                  ]
                );
              } else if (hasClientOrgFieldValues) {
                await client.query(
                  "UPDATE client_entities SET entity_type = NULLIF($1, ''), org_structure_node_id = $2, org_structure_path = $3::jsonb, org_field_values = COALESCE($4::jsonb, org_field_values), pan = NULLIF($5, ''), reporting_partner_mobile = NULLIF($6, ''), updated_at = CURRENT_TIMESTAMP WHERE id = $7",
                  [
                    entity_type || null,
                    orgStructureNodeId,
                    orgStructurePathJson,
                    orgFieldValuesJson,
                    pan || null,
                    reporting_partner_mobile || null,
                    existing.rows[0].id,
                  ]
                );
              } else {
                await client.query(
                  "UPDATE client_entities SET entity_type = NULLIF($1, ''), org_structure_node_id = $2, org_structure_path = $3::jsonb, pan = NULLIF($4, ''), reporting_partner_mobile = NULLIF($5, ''), updated_at = CURRENT_TIMESTAMP WHERE id = $6",
                  [entity_type || null, orgStructureNodeId, orgStructurePathJson, pan || null, reporting_partner_mobile || null, existing.rows[0].id]
                );
              }
            } else {
              if (hasClientEntityStatus && hasClientOrgFieldValues) {
                await client.query(
                  "INSERT INTO client_entities (organization_id, name, entity_type, status, org_structure_node_id, org_structure_path, org_field_values, pan, reporting_partner_mobile) VALUES ($1, $2, NULLIF($3, ''), COALESCE($4, 'active'), $5, $6::jsonb, $7::jsonb, NULLIF($8, ''), NULLIF($9, ''))",
                  [
                    orgId,
                    name,
                    entity_type || null,
                    status,
                    orgStructureNodeId,
                    orgStructurePathJson,
                    orgFieldValuesJson,
                    pan || null,
                    reporting_partner_mobile || null,
                  ]
                );
              } else if (hasClientEntityStatus) {
                await client.query(
                  "INSERT INTO client_entities (organization_id, name, entity_type, status, org_structure_node_id, org_structure_path, pan, reporting_partner_mobile) VALUES ($1, $2, NULLIF($3, ''), COALESCE($4, 'active'), $5, $6::jsonb, NULLIF($7, ''), NULLIF($8, ''))",
                  [orgId, name, entity_type || null, status, orgStructureNodeId, orgStructurePathJson, pan || null, reporting_partner_mobile || null]
                );
              } else if (hasClientOrgFieldValues) {
                await client.query(
                  "INSERT INTO client_entities (organization_id, name, entity_type, org_structure_node_id, org_structure_path, org_field_values, pan, reporting_partner_mobile) VALUES ($1, $2, NULLIF($3, ''), $4, $5::jsonb, $6::jsonb, NULLIF($7, ''), NULLIF($8, ''))",
                  [
                    orgId,
                    name,
                    entity_type || null,
                    orgStructureNodeId,
                    orgStructurePathJson,
                    orgFieldValuesJson,
                    pan || null,
                    reporting_partner_mobile || null,
                  ]
                );
              } else {
                await client.query(
                  "INSERT INTO client_entities (organization_id, name, entity_type, org_structure_node_id, org_structure_path, pan, reporting_partner_mobile) VALUES ($1, $2, NULLIF($3, ''), $4, $5::jsonb, NULLIF($6, ''), NULLIF($7, ''))",
                  [orgId, name, entity_type || null, orgStructureNodeId, orgStructurePathJson, pan || null, reporting_partner_mobile || null]
                );
              }
            }
            result.updated.client_entities += 1;

            // Entity List compliance columns -> client_entity_services (same row)
            const clientEntityId = (existing.rows[0]?.id ?? (await client.query(
              'SELECT id FROM client_entities WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
              [orgId, name]
            )).rows[0]?.id) as string | undefined;
            if (clientEntityId && complianceCols.length > 0) {
              for (const { colIndex, taskServiceTitle } of complianceCols) {
                const frequencyVal = getCellStr(row, colIndex);
                const frequency = normalizeFrequency(frequencyVal || 'NA');
                const taskServiceId = await resolveTaskServiceCached(orgId, taskServiceTitle, 'recurring');
                if (!taskServiceId) continue;
                await client.query(
                  `INSERT INTO client_entity_services (client_entity_id, task_service_id, frequency, created_at, updated_at)
                   VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                   ON CONFLICT (client_entity_id, task_service_id) DO UPDATE SET frequency = EXCLUDED.frequency, updated_at = CURRENT_TIMESTAMP`,
                  [clientEntityId, taskServiceId, frequency]
                );
                result.updated.client_entity_services += 1;
              }
            }
          } catch (err: any) {
            pushError({ sheet: clientSheet.name, row: r, message: err?.message ?? String(err) });
          }
        }
        console.log('[EntityMasterUpload] Entity List / Client Entities processed', { updated: result.updated.client_entities, client_entity_services: result.updated.client_entity_services });
      }
    }

    // --- Client entity services (Client Entity Services or legacy) ---
    const cesSheet = getSheet(['Client Entity Services', 'Client entity services']);
    console.log('[EntityMasterUpload] Client Entity Services sheet', cesSheet ? { name: cesSheet.name, rowCount: cesSheet.rowCount } : 'NOT FOUND');
    if (cesSheet && cesSheet.rowCount >= 2) {
      const headers = cesSheet.getRow(1).values as any[];
      const clientNameIdx = headers.findIndex((h: any) => String(h || '').trim().toLowerCase() === 'client_entity_name');
      const taskTitleIdx = headers.findIndex((h: any) => String(h || '').trim().toLowerCase() === 'task_service_title');
      const taskTypeIdx = headers.findIndex((h: any) => String(h || '').trim().toLowerCase() === 'task_type');
      const frequencyIdx = headers.findIndex((h: any) => String(h || '').trim().toLowerCase() === 'frequency');
      if (clientNameIdx >= 0 && taskTitleIdx >= 0 && taskTypeIdx >= 0 && frequencyIdx >= 0) {
        const maxRow = lastRow(cesSheet);
        if (hasMoreThanMaxRows(cesSheet))
          pushError({ sheet: cesSheet.name, message: `Sheet has more than ${MAX_ROWS_PER_SHEET} rows; only first ${MAX_ROWS_PER_SHEET} processed.` });
        for (let r = 2; r <= maxRow; r++) {
          try {
            const row = cesSheet.getRow(r);
            if (isRowEmpty(row, [clientNameIdx, taskTitleIdx])) continue;
            const client_entity_name = getCellStrMax(row, clientNameIdx, NAME_MAX);
            const task_service_title = getCellStrMax(row, taskTitleIdx, TITLE_MAX);
            const task_type = normalizeTaskType(getCellStr(row, taskTypeIdx));
            const frequency = normalizeFrequency(getCellStr(row, frequencyIdx) || 'NA');
            if (!client_entity_name || !task_service_title || !task_type) continue;
            const orgId = defaultOrgId;
            if (!orgId) continue;
            const clientEntityId = await resolveClientEntityCached(orgId, client_entity_name);
            if (!clientEntityId) {
              pushError({ sheet: cesSheet.name, row: r, message: `Client entity not found: ${client_entity_name}` });
              continue;
            }
            const taskServiceId = await resolveTaskServiceCached(orgId, task_service_title, task_type);
            if (!taskServiceId) {
              pushError({ sheet: cesSheet.name, row: r, message: `Task service not found: ${task_service_title} (${task_type})` });
              continue;
            }
            await client.query(
              `INSERT INTO client_entity_services (client_entity_id, task_service_id, frequency, created_at, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (client_entity_id, task_service_id) DO UPDATE SET frequency = EXCLUDED.frequency, updated_at = CURRENT_TIMESTAMP`,
              [clientEntityId, taskServiceId, frequency]
            );
            result.updated.client_entity_services += 1;
          } catch (err: any) {
            pushError({ sheet: cesSheet.name, row: r, message: err?.message ?? String(err) });
          }
        }
        console.log('[EntityMasterUpload] Client Entity Services processed', { updated: result.updated.client_entity_services });
      }
    }

    // --- Employees ---
    const employeesSheet = workbook.getWorksheet('Employees');
    console.log('[EntityMasterUpload] Employees sheet', employeesSheet ? { name: employeesSheet.name, rowCount: employeesSheet.rowCount, defaultOrgId } : 'NOT FOUND');
    if (employeesSheet && employeesSheet.rowCount >= 2 && defaultOrgId) {
      const headers = employeesSheet.getRow(1).values as any[];
      const mobileIdx = colAny(headers, 'mobile', 'mobile number');
      const nameIdx = colAny(headers, 'name', 'name of the employee');
      const reportIdx = colAny(headers, 'reporting_to_mobile', 'reporting to');
      const employeeOrgFieldValuesColumn = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'user_organizations' AND column_name = 'org_field_values'`
      );
      const hasEmployeeOrgFieldValues = employeeOrgFieldValuesColumn.rows.length > 0;
      const employeeStructureLevels = await loadOrganizationStructureLevels(client, defaultOrgId);
      if (mobileIdx >= 0 && nameIdx >= 0) {
        const maxRow = lastRow(employeesSheet);
        if (hasMoreThanMaxRows(employeesSheet))
          pushError({ sheet: 'Employees', message: `Sheet has more than ${MAX_ROWS_PER_SHEET} rows; only first ${MAX_ROWS_PER_SHEET} processed.` });
        for (let r = 2; r <= maxRow; r++) {
          try {
            const row = employeesSheet.getRow(r);
            if (isRowEmpty(row, [mobileIdx])) continue;
            const mobile = getCellStr(row, mobileIdx);
            const name = getCellStrMax(row, nameIdx, NAME_MAX);
            if (!mobile) continue;
            let mobileNorm = mobile.trim().replace(/\s/g, '');
            // Normalize: accept 10 digits, 12 digits starting with 91, or +91XXXXXXXXXX
            if (mobileNorm.startsWith('+')) {
              mobileNorm = mobileNorm.replace(/\D/g, '').replace(/^(\d+)$/, '+$1');
            } else {
              const digits = mobileNorm.replace(/\D/g, '');
              if (digits.length === 10) {
                mobileNorm = '+91' + digits;
              } else if (digits.length === 12 && digits.startsWith('91')) {
                mobileNorm = '+' + digits;
              } else if (digits.length >= 6 && digits.length <= 20) {
                mobileNorm = '+91' + digits.slice(-10); // Take last 10 digits if longer
              } else {
                pushError({ sheet: 'Employees', row: r, message: `Invalid mobile format: ${mobile}` });
                continue;
              }
            }
            if (!/^\+\d{6,20}$/.test(mobileNorm)) {
              pushError({ sheet: 'Employees', row: r, message: `Invalid mobile: ${mobile}` });
              continue;
            }
            const reporting_to_value = reportIdx >= 0 ? getCellStr(row, reportIdx) : '';
            let reporting_to: string | null = null;
            if (reporting_to_value?.trim()) {
              reporting_to = await resolveReportingToByMobileOrName(client, defaultOrgId, reporting_to_value);
            }
            const assignment = await resolveOrgAssignmentForBulkRow(
              defaultOrgId,
              row,
              headers,
              employeeStructureLevels,
              resolveOrgNodeCached,
              [
                'org structure node id',
                'org_structure_node_id',
                'org node id',
                'organization node id',
                'primary org unit',
                'primary org node',
                'primary org node id',
                'primary org unit id',
              ]
            );
            const primary_org_node_id = assignment.org_structure_node_id;
            const orgFieldValuesJson = JSON.stringify(assignment.org_field_values ?? {});
            let employeeUserId: string;
            const existingUserId = await resolveUserIdByMobile(client, mobileNorm);
            if (existingUserId) {
              employeeUserId = existingUserId;
              await client.query(
                'UPDATE users SET name = COALESCE(NULLIF($1,\'\'), name), updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [name || null, employeeUserId]
              );
            } else {
              const passwordHash = await bcrypt.hash(DEFAULT_EMPLOYEE_PASSWORD, 10);
              const newUser = await client.query(
                `INSERT INTO users (mobile, name, role, status, password_hash, must_change_password) VALUES ($1, $2, 'employee', 'active', $3, true) RETURNING id`,
                [mobileNorm, name || 'Employee', passwordHash]
              );
              employeeUserId = newUser.rows[0].id;
              await client.query(
                'INSERT INTO profiles (user_id, about, contact_number) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING',
                [employeeUserId, 'Hey there! I am using OrgIT.', mobileNorm]
              );
            }
            if (hasEmployeeOrgFieldValues) {
              await client.query(
                `INSERT INTO user_organizations (user_id, organization_id, reporting_to, primary_org_node_id, org_field_values, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id, organization_id) DO UPDATE SET reporting_to = $3, primary_org_node_id = $4, org_field_values = COALESCE($5::jsonb, user_organizations.org_field_values), updated_at = CURRENT_TIMESTAMP`,
                [employeeUserId, defaultOrgId, reporting_to, primary_org_node_id, orgFieldValuesJson]
              );
            } else {
              await client.query(
                `INSERT INTO user_organizations (user_id, organization_id, reporting_to, primary_org_node_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id, organization_id) DO UPDATE SET reporting_to = $3, primary_org_node_id = $4, updated_at = CURRENT_TIMESTAMP`,
                [employeeUserId, defaultOrgId, reporting_to, primary_org_node_id]
              );
            }
            result.updated.employees += 1;
          } catch (err: any) {
            pushError({ sheet: 'Employees', row: r, message: err?.message ?? String(err) });
          }
        }
        console.log('[EntityMasterUpload] Employees processed', { updated: result.updated.employees });
      }
    } else if (!defaultOrgId) {
      console.log('[EntityMasterUpload] Employees skipped: no defaultOrgId (user has no organization)');
    }

    await client.query('COMMIT');
    console.log('[EntityMasterUpload] Commit OK', { updated: result.updated, errors: result.errors.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return result;
}

// --- Row-level queue: create one row from payload (used by entity master bulk worker) ---

export interface EmployeeJobPayload {
  mobile_normalized: string;
  name: string;
  reporting_to_user_id: string | null;
  primary_org_node_id: string | null;
  org_field_values: Record<string, unknown> | null;
}

export interface ServiceListJobPayload {
  organization_id: string;
  services: Array<{
    title: string;
    task_type: string;
    frequency: string;
    rollout_rule: string;
    is_active: boolean;
  }>;
}

export interface EntityListJobPayload {
  organization_id: string;
  name: string;
  entity_type: string | null;
  status: string | null;
  org_structure_node_id: string | null;
  org_structure_path: string | null;
  org_field_values: Record<string, unknown> | null;
  pan: string | null;
  reporting_partner_mobile: string | null;
  compliance: Array<{ task_service_id: string; frequency: string }>;
}

/**
 * Build employee payloads from a workbook that has only an 'Employees' sheet. Used when enqueueing row-level jobs.
 */
export async function buildEmployeePayloadsFromSheet(
  workbook: ExcelJS.Workbook,
  client: any,
  organizationId: string
): Promise<EmployeeJobPayload[]> {
  const sheet = workbook.getWorksheet('Employees');
  if (!sheet || (sheet.rowCount ?? 0) < 2) return [];
  const headers = sheet.getRow(1).values as any[];
  const mobileIdx = colAny(headers, 'mobile', 'mobile number');
  const nameIdx = colAny(headers, 'name', 'name of the employee');
  const reportIdx = colAny(headers, 'reporting_to_mobile', 'reporting to');
  if (mobileIdx < 0 || nameIdx < 0) return [];
  const structureLevels = await loadOrganizationStructureLevels(client, organizationId);
  const payloads: EmployeeJobPayload[] = [];
  const orgNodeCache = new Map<string, string | null>();
  const resolveOrgNodeCached = async (orgId: string, hint: string): Promise<string | null> => {
    const key = `${orgId}|${hint.trim().toLowerCase()}`;
    if (orgNodeCache.has(key)) return orgNodeCache.get(key)!;
    const id = await resolveOrgStructureNodeId(client, orgId, hint);
    orgNodeCache.set(key, id);
    return id;
  };
  const maxRow = lastRow(sheet);
  for (let r = 2; r <= maxRow; r++) {
    const row = sheet.getRow(r);
    if (isRowEmpty(row, [mobileIdx])) continue;
    const mobile = getCellStr(row, mobileIdx);
    const name = getCellStrMax(row, nameIdx, NAME_MAX);
    if (!mobile) continue;
    let mobileNorm = mobile.trim().replace(/\s/g, '');
    if (mobileNorm.startsWith('+')) {
      mobileNorm = mobileNorm.replace(/\D/g, '').replace(/^(\d+)$/, '+$1');
    } else {
      const digits = mobileNorm.replace(/\D/g, '');
      if (digits.length === 10) mobileNorm = '+91' + digits;
      else if (digits.length === 12 && digits.startsWith('91')) mobileNorm = '+' + digits;
      else if (digits.length >= 6 && digits.length <= 20) mobileNorm = '+91' + digits.slice(-10);
      else continue;
    }
    if (!/^\+\d{6,20}$/.test(mobileNorm)) continue;
    const reporting_to_value = reportIdx >= 0 ? getCellStr(row, reportIdx) : '';
    const reporting_to_user_id = reporting_to_value?.trim()
      ? await resolveReportingToByMobileOrName(client, organizationId, reporting_to_value)
      : null;
    const assignment = await resolveOrgAssignmentForBulkRow(
      organizationId,
      row,
      headers,
      structureLevels,
      resolveOrgNodeCached,
      [
        'org structure node id',
        'org_structure_node_id',
        'org node id',
        'organization node id',
        'primary org unit',
        'primary org node',
        'primary org node id',
        'primary org unit id',
      ]
    );
    payloads.push({
      mobile_normalized: mobileNorm,
      name: name || 'Employee',
      reporting_to_user_id,
      primary_org_node_id: assignment.org_structure_node_id,
      org_field_values: assignment.org_field_values,
    });
  }
  return payloads;
}

/**
 * Build service list payloads from a workbook that has only a 'Service List' sheet. Used when enqueueing row-level jobs.
 */
export async function buildServiceListPayloadsFromSheet(
  workbook: ExcelJS.Workbook,
  client: any,
  organizationId: string,
  isSuperAdmin: boolean
): Promise<ServiceListJobPayload[]> {
  const sheet = workbook.getWorksheet('Service List');
  if (!sheet || (sheet.rowCount ?? 0) < 2) return [];
  const headers = sheet.getRow(1).values as any[];
  const orgNameIdx = colAny(headers, 'organization_name');
  const recurringTitleIdx = colAny(headers, 'recurring task title/service list', 'recurring title', 'title');
  const freqIdx = colAny(headers, 'frequency');
  const rolloutIdx = colAny(headers, 'task roll out', 'rollout_rule');
  const oneTimeTitleIdx = colAny(headers, 'one time task list', 'one_time title');
  const maxRow = lastRow(sheet);
  const payloads: ServiceListJobPayload[] = [];
  for (let r = 2; r <= maxRow; r++) {
    const row = sheet.getRow(r);
    let orgId = organizationId;
    if (isSuperAdmin && orgNameIdx >= 0) {
      const on = getCellStr(row, orgNameIdx);
      if (on) orgId = (await resolveOrganizationId(client, on)) ?? organizationId;
    }
    if (!orgId) continue;
    if (recurringTitleIdx < 0 && oneTimeTitleIdx < 0) continue;
    const recurringTitle = recurringTitleIdx >= 0 ? getCellStrMax(row, recurringTitleIdx, TITLE_MAX) : '';
    const oneTimeTitle = oneTimeTitleIdx >= 0 ? getCellStrMax(row, oneTimeTitleIdx, TITLE_MAX) : '';
    if (!recurringTitle && !oneTimeTitle) continue;
    const frequency = freqIdx >= 0 ? getCellStr(row, freqIdx) || 'NA' : 'NA';
    const rollout_rule = rolloutIdx >= 0 ? getCellStr(row, rolloutIdx) : 'end_of_period';
    const services: ServiceListJobPayload['services'] = [];
    if (recurringTitle) services.push({ title: recurringTitle, task_type: 'recurring', frequency, rollout_rule, is_active: true });
    if (oneTimeTitle) services.push({ title: oneTimeTitle, task_type: 'one_time', frequency: 'NA', rollout_rule: 'end_of_period', is_active: true });
    if (services.length) payloads.push({ organization_id: orgId, services });
  }
  return payloads;
}

/**
 * Build entity list payloads from a workbook that has only 'Entity List' or 'Client Entities' sheet. Used when enqueueing row-level jobs.
 */
export async function buildEntityListPayloadsFromSheet(
  workbook: ExcelJS.Workbook,
  client: any,
  organizationId: string,
  isSuperAdmin: boolean
): Promise<EntityListJobPayload[]> {
  const sheet =
    workbook.getWorksheet('Client List') ??
    workbook.getWorksheet('Entity List') ??
    workbook.getWorksheet('Client Entities');
  if (!sheet || (sheet.rowCount ?? 0) < 2) return [];
  const headers = sheet.getRow(1).values as any[];
  const nameIdx = colAny(headers, 'name', 'name of the client');
  const orgNameIdx = colAny(headers, 'organization_name');
  const entityTypeIdx = colAny(headers, 'entity_type', 'entity type');
  const statusIdx = colAny(headers, 'status');
  const legacyCols = findLegacyEntityListColumns(headers);
  if (legacyCols.length > 0) return [];
  const panIdx = colAny(headers, 'pan');
  const reportingPartnerIdx = colAny(headers, 'reporting_partner_mobile', 'reporting partner', 'reporting_partner');
  const normalizeClientEntityStatus = (raw: string): string | null => {
    const v = (raw || '').trim().toLowerCase();
    if (!v) return null;
    if (v === 'active' || v === 'inactive') return v;
    if (v === '1' || v === 'true' || v === 'yes') return 'active';
    if (v === '0' || v === 'false' || v === 'no') return 'inactive';
    return null;
  };
  const allowedTitles = await getRecurringTaskServiceTitlesForEntityList(organizationId, client);
  const complianceCols: Array<{ colIndex: number; taskServiceTitle: string }> = [];
  for (let i = 1; i < (headers?.length ?? 0); i++) {
    const h = String(headers[i] ?? '').trim();
    if (!h) continue;
    const match = allowedTitles.find((t) => t.toLowerCase() === h.toLowerCase());
    if (match) complianceCols.push({ colIndex: i, taskServiceTitle: match });
  }
  if (nameIdx < 0) return [];
  const payloads: EntityListJobPayload[] = [];
  const orgNodeCache = new Map<string, string | null>();
  const resolveOrgNodeCached = async (orgId: string, hint: string): Promise<string | null> => {
    const key = `${orgId}|${hint.trim().toLowerCase()}`;
    if (orgNodeCache.has(key)) return orgNodeCache.get(key)!;
    const id = await resolveOrgStructureNodeId(client, orgId, hint);
    orgNodeCache.set(key, id);
    return id;
  };
  const structureLevelsCache = new Map<string, OrganizationStructureLevel[]>();
  const loadLevelsCached = async (orgId: string) => {
    if (!structureLevelsCache.has(orgId)) {
      structureLevelsCache.set(orgId, await loadOrganizationStructureLevels(client, orgId));
    }
    return structureLevelsCache.get(orgId)!;
  };
  const maxRow = lastRow(sheet);
  for (let r = 2; r <= maxRow; r++) {
    const row = sheet.getRow(r);
    if (isRowEmpty(row, [nameIdx])) continue;
    const name = getCellStrMax(row, nameIdx, NAME_MAX);
    if (!name) continue;
    let orgId = organizationId;
    if (isSuperAdmin && orgNameIdx >= 0) {
      const on = getCellStr(row, orgNameIdx);
      if (on) orgId = (await resolveOrganizationId(client, on)) ?? organizationId;
    }
    if (!orgId) continue;
    const entity_type = entityTypeIdx >= 0 ? getCellStrMax(row, entityTypeIdx, NAME_MAX) : '';
    const statusRaw = statusIdx >= 0 ? getCellStr(row, statusIdx) : '';
    const status = normalizeClientEntityStatus(statusRaw);
    const pan = panIdx >= 0 ? getCellStrMax(row, panIdx, 50) : '';
    const reporting_partner_mobile = reportingPartnerIdx >= 0 ? getCellStrMax(row, reportingPartnerIdx, PHONE_PIN_MAX) : '';
    const structureLevels = await loadLevelsCached(orgId);
    const assignment = await resolveOrgAssignmentForBulkRow(
      orgId,
      row,
      headers,
      structureLevels,
      resolveOrgNodeCached,
      [
        'org_structure_node_id',
        'org structure node id',
        'org node id',
        'organization node id',
        'org unit id',
        'organization unit id',
      ]
    );
    const compliance: EntityListJobPayload['compliance'] = [];
    for (const { colIndex, taskServiceTitle } of complianceCols) {
      const frequencyVal = getCellStr(row, colIndex);
      const frequency = normalizeFrequency(frequencyVal || 'NA');
      const task_service_id = await resolveTaskServiceId(client, orgId, taskServiceTitle, 'recurring');
      if (task_service_id) compliance.push({ task_service_id, frequency });
    }
    payloads.push({
      organization_id: orgId,
      name,
      entity_type: entity_type || null,
      status,
      org_structure_node_id: assignment.org_structure_node_id,
      org_structure_path: assignment.org_structure_path,
      org_field_values: assignment.org_field_values,
      pan: pan || null,
      reporting_partner_mobile: reporting_partner_mobile || null,
      compliance,
    });
  }
  return payloads;
}

/**
 * Create or update one employee from payload. Used by row-level bulk worker.
 * Returns the user_id (employee).
 */
export async function createEmployeeFromPayload(
  client: any,
  payload: EmployeeJobPayload,
  organizationId: string
): Promise<string> {
  const { mobile_normalized, name, reporting_to_user_id, primary_org_node_id, org_field_values } = payload;
  let employeeUserId: string;
  const existingUserId = (await client.query(
    'SELECT id FROM users WHERE REPLACE(mobile, \' \', \'\') = $1 OR mobile = $1 LIMIT 1',
    [mobile_normalized]
  )).rows[0]?.id;
  if (existingUserId) {
    employeeUserId = existingUserId;
    await client.query(
      'UPDATE users SET name = COALESCE(NULLIF($1,\'\'), name), updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [name || null, employeeUserId]
    );
  } else {
    const passwordHash = await bcrypt.hash(DEFAULT_EMPLOYEE_PASSWORD, 10);
    const newUser = await client.query(
      `INSERT INTO users (mobile, name, role, status, password_hash, must_change_password) VALUES ($1, $2, 'employee', 'active', $3, true) RETURNING id`,
      [mobile_normalized, name || 'Employee', passwordHash]
    );
    employeeUserId = newUser.rows[0].id;
    await client.query(
      'INSERT INTO profiles (user_id, about, contact_number) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING',
      [employeeUserId, 'Hey there! I am using OrgIT.', mobile_normalized]
    );
  }
  const orgFieldValuesColumn = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'user_organizations' AND column_name = 'org_field_values'`
  );
  const hasOrgFieldValues = orgFieldValuesColumn.rows.length > 0;
  const orgFieldValuesJson = org_field_values ? JSON.stringify(org_field_values) : null;
  if (hasOrgFieldValues) {
    await client.query(
      `INSERT INTO user_organizations (user_id, organization_id, reporting_to, primary_org_node_id, org_field_values, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, organization_id) DO UPDATE SET reporting_to = $3, primary_org_node_id = $4, org_field_values = COALESCE($5::jsonb, user_organizations.org_field_values), updated_at = CURRENT_TIMESTAMP`,
      [employeeUserId, organizationId, reporting_to_user_id, primary_org_node_id, orgFieldValuesJson]
    );
  } else {
    await client.query(
      `INSERT INTO user_organizations (user_id, organization_id, reporting_to, primary_org_node_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, organization_id) DO UPDATE SET reporting_to = $3, primary_org_node_id = $4, updated_at = CURRENT_TIMESTAMP`,
      [employeeUserId, organizationId, reporting_to_user_id, primary_org_node_id]
    );
  }
  return employeeUserId;
}

/**
 * Create or update task_services from payload. Used by row-level bulk worker.
 * Payload can have 1 or 2 services (recurring + one_time). Returns count of services processed.
 */
export async function createTaskServiceFromPayload(
  client: any,
  payload: ServiceListJobPayload,
  _organizationId: string
): Promise<number> {
  const orgId = payload.organization_id || _organizationId;
  const freqNorm = (s: string) => {
    const t = (s || '').trim();
    if (!t) return 'NA';
    const found = TASK_FREQUENCIES.find((f) => f.toLowerCase() === t.toLowerCase());
    return found ?? 'NA';
  };
  const rollNorm = (s: string) => {
    const raw = (s || '').trim();
    if (!raw) return 'end_of_period';
    const t = raw.toLowerCase().replace(/\s+/g, '_');
    if (t.includes('one_month') || t.includes('before_period') || raw.toLowerCase().includes('1 month before')) return 'one_month_before_period_end';
    return 'end_of_period';
  };
  const TITLE_MAX = 500;
  let count = 0;
  for (const svc of payload.services) {
    const titleSafe = (svc.title || '').trim().slice(0, TITLE_MAX);
    if (!titleSafe || !svc.task_type) continue;
    const freqNormVal = freqNorm(svc.frequency);
    const rollNormVal = rollNorm(svc.rollout_rule);
    const existing = await client.query(
      `SELECT id FROM task_services WHERE (organization_id IS NOT DISTINCT FROM $1) AND LOWER(TRIM(title)) = LOWER($2) AND task_type = $3 LIMIT 1`,
      [orgId, titleSafe, svc.task_type]
    );
    if (existing.rows.length > 0) {
      await client.query(
        'UPDATE task_services SET frequency = $1, rollout_rule = $2, is_active = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
        [freqNormVal, rollNormVal, svc.is_active, existing.rows[0].id]
      );
    } else {
      await client.query(
        'INSERT INTO task_services (organization_id, title, task_type, frequency, rollout_rule, is_active) VALUES ($1, $2, $3, $4, $5, $6)',
        [orgId, titleSafe, svc.task_type, freqNormVal, rollNormVal, svc.is_active]
      );
    }
    count += 1;
  }
  return count;
}

/**
 * Create or update one client_entity and its client_entity_services from payload. Used by row-level bulk worker.
 * Returns the client_entity id.
 */
export async function createClientEntityFromPayload(
  client: any,
  payload: EntityListJobPayload,
  _organizationId: string
): Promise<string> {
  const {
    organization_id,
    name,
    entity_type,
    status,
    org_structure_node_id,
    org_structure_path,
    org_field_values,
    pan,
    reporting_partner_mobile,
    compliance,
  } = payload;
  const orgId = organization_id || _organizationId;
  const nameTrim = (name || '').trim();
  if (!nameTrim) throw new Error('Client entity name is required');
  const NAME_MAX = 255;
  const nameSafe = nameTrim.slice(0, NAME_MAX);
  const clientEntityStatusColumn = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'client_entities' AND column_name = 'status'`
  );
  const hasClientEntityStatus = clientEntityStatusColumn.rows.length > 0;
  const clientOrgFieldValuesColumn = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'client_entities' AND column_name = 'org_field_values'`
  );
  const hasClientOrgFieldValues = clientOrgFieldValuesColumn.rows.length > 0;
  const orgFieldValuesJson = org_field_values ? JSON.stringify(org_field_values) : null;
  const existing = await client.query(
    'SELECT id FROM client_entities WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
    [orgId, nameSafe]
  );
  let clientEntityId: string;
  if (existing.rows.length > 0) {
    clientEntityId = existing.rows[0].id;
    if (hasClientEntityStatus && hasClientOrgFieldValues) {
      await client.query(
        "UPDATE client_entities SET entity_type = NULLIF($1, ''), status = COALESCE($2, status), org_structure_node_id = $3, org_structure_path = $4::jsonb, org_field_values = COALESCE($5::jsonb, org_field_values), pan = NULLIF($6, ''), reporting_partner_mobile = NULLIF($7, ''), updated_at = CURRENT_TIMESTAMP WHERE id = $8",
        [
          entity_type || null,
          status || null,
          org_structure_node_id,
          org_structure_path,
          orgFieldValuesJson,
          pan || null,
          reporting_partner_mobile || null,
          clientEntityId,
        ]
      );
    } else if (hasClientEntityStatus) {
      await client.query(
        "UPDATE client_entities SET entity_type = NULLIF($1, ''), status = COALESCE($2, status), org_structure_node_id = $3, org_structure_path = $4::jsonb, pan = NULLIF($5, ''), reporting_partner_mobile = NULLIF($6, ''), updated_at = CURRENT_TIMESTAMP WHERE id = $7",
        [entity_type || null, status || null, org_structure_node_id, org_structure_path, pan || null, reporting_partner_mobile || null, clientEntityId]
      );
    } else if (hasClientOrgFieldValues) {
      await client.query(
        "UPDATE client_entities SET entity_type = NULLIF($1, ''), org_structure_node_id = $2, org_structure_path = $3::jsonb, org_field_values = COALESCE($4::jsonb, org_field_values), pan = NULLIF($5, ''), reporting_partner_mobile = NULLIF($6, ''), updated_at = CURRENT_TIMESTAMP WHERE id = $7",
        [
          entity_type || null,
          org_structure_node_id,
          org_structure_path,
          orgFieldValuesJson,
          pan || null,
          reporting_partner_mobile || null,
          clientEntityId,
        ]
      );
    } else {
      await client.query(
        "UPDATE client_entities SET entity_type = NULLIF($1, ''), org_structure_node_id = $2, org_structure_path = $3::jsonb, pan = NULLIF($4, ''), reporting_partner_mobile = NULLIF($5, ''), updated_at = CURRENT_TIMESTAMP WHERE id = $6",
        [entity_type || null, org_structure_node_id, org_structure_path, pan || null, reporting_partner_mobile || null, clientEntityId]
      );
    }
  } else {
    const ins = hasClientEntityStatus && hasClientOrgFieldValues
      ? await client.query(
          "INSERT INTO client_entities (organization_id, name, entity_type, status, org_structure_node_id, org_structure_path, org_field_values, pan, reporting_partner_mobile) VALUES ($1, $2, NULLIF($3, ''), COALESCE($4, 'active'), $5, $6::jsonb, $7::jsonb, NULLIF($8, ''), NULLIF($9, '')) RETURNING id",
          [
            orgId,
            nameSafe,
            entity_type || null,
            status || null,
            org_structure_node_id,
            org_structure_path,
            orgFieldValuesJson,
            pan || null,
            reporting_partner_mobile || null,
          ]
        )
      : hasClientEntityStatus
        ? await client.query(
            "INSERT INTO client_entities (organization_id, name, entity_type, status, org_structure_node_id, org_structure_path, pan, reporting_partner_mobile) VALUES ($1, $2, NULLIF($3, ''), COALESCE($4, 'active'), $5, $6::jsonb, NULLIF($7, ''), NULLIF($8, '')) RETURNING id",
            [orgId, nameSafe, entity_type || null, status || null, org_structure_node_id, org_structure_path, pan || null, reporting_partner_mobile || null]
          )
        : hasClientOrgFieldValues
          ? await client.query(
              "INSERT INTO client_entities (organization_id, name, entity_type, org_structure_node_id, org_structure_path, org_field_values, pan, reporting_partner_mobile) VALUES ($1, $2, NULLIF($3, ''), $4, $5::jsonb, $6::jsonb, NULLIF($7, ''), NULLIF($8, '')) RETURNING id",
              [
                orgId,
                nameSafe,
                entity_type || null,
                org_structure_node_id,
                org_structure_path,
                orgFieldValuesJson,
                pan || null,
                reporting_partner_mobile || null,
              ]
            )
          : await client.query(
              "INSERT INTO client_entities (organization_id, name, entity_type, org_structure_node_id, org_structure_path, pan, reporting_partner_mobile) VALUES ($1, $2, NULLIF($3, ''), $4, $5::jsonb, NULLIF($6, ''), NULLIF($7, '')) RETURNING id",
              [orgId, nameSafe, entity_type || null, org_structure_node_id, org_structure_path, pan || null, reporting_partner_mobile || null]
            );
    clientEntityId = ins.rows[0].id;
  }
  const freqNorm = (s: string) => {
    const t = (s || '').trim();
    if (!t) return 'NA';
    const found = TASK_FREQUENCIES.find((f) => f.toLowerCase() === t.toLowerCase());
    return found ?? 'NA';
  };
  for (const item of compliance || []) {
    if (!item.task_service_id) continue;
    const frequency = freqNorm(item.frequency || 'NA');
    await client.query(
      `INSERT INTO client_entity_services (client_entity_id, task_service_id, frequency, created_at, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (client_entity_id, task_service_id) DO UPDATE SET frequency = EXCLUDED.frequency, updated_at = CURRENT_TIMESTAMP`,
      [clientEntityId, item.task_service_id, frequency]
    );
  }
  return clientEntityId;
}
