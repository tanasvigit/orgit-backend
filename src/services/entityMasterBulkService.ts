import ExcelJS from 'exceljs';
import bcrypt from 'bcryptjs';
import { PoolClient } from 'pg';
import { getClient, query } from '../config/database';
import { ORG_CONSTITUTION_VALUES, ORG_CONSTITUTION_OPTIONS } from './masterDataService';

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
  { label: 'Branches', key: '_branches' },
  { label: 'Departments', key: '_departments' },
  { label: 'Cost Centre', key: '_cost_centre' },
  { label: 'Cost Centre 1', key: '_cost_centre_1' },
  { label: 'Cost Centre 1 Short Name', key: '_cost_centre_1_short' },
  { label: 'Cost Centre 2', key: '_cost_centre_2' },
  { label: 'Cost Centre 2 Short Name', key: '_cost_centre_2_short' },
  { label: 'Depot (count; list on Depot sheet)', key: 'depot_count' },
  { label: 'Warehouse (count; list on Warehouse sheet)', key: 'warehouse_count' },
  { label: 'Country', key: 'country_name' },
  { label: 'State', key: 'state_name' },
  { label: 'City', key: 'city_name' },
  { label: 'Pin Code', key: 'pin_code' },
  { label: 'Address Line 1', key: 'address_line1' },
  { label: 'Address Line 2', key: 'address_line2' },
  { label: 'Name of the Branch', key: '_branch_name' },
  { label: 'Branch Short Name', key: '_branch_short_name' },
  { label: 'Address of the Branch', key: '_branch_address' },
  { label: 'Branch GST Number', key: '_branch_gst' },
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
    cost_centres: number;
    branches: number;
    depots: number;
    warehouses: number;
    task_services: number;
    client_entities: number;
    client_entity_services: number;
    employees: number;
  };
  errors: Array<{ sheet?: string; row?: number; message: string }>;
}

/**
 * Build Excel template workbook "OrgIt Settings" – one workbook with all updated sheets.
 * Sheet order: Entity Master Data (Org), Entity List, Service List, Employees, Cost Centres, Branches.
 * Sheet names match sections: /admin/entity-master, /admin/entities, /admin/services, /admin/users.
 * Entity List compliance columns are driven by task_services (recurring) in DB only; no initial list.
 */
export async function buildTemplateWorkbook(): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OrgIt Settings';
  workbook.created = new Date();

  const complianceHeaders = await getRecurringTaskServiceTitles(null);

  // Sheet 1: Entity Master Data (Org) – vertical layout: column A = field labels, column B = values
  const orgSheet = workbook.addWorksheet('Entity Master Data (Org)', {
    headerFooter: { firstHeader: 'OrgIt Settings - Entity Master Data (Organisation)' },
  });
  orgSheet.getColumn(1).width = 28;
  orgSheet.getColumn(2).width = 40;
  const orgConstitutionLabels = ORG_CONSTITUTION_OPTIONS.map((o) => o.label);
  ENTITY_MASTER_TEMPLATE_VERTICAL_FIELDS.forEach((f, i) => {
    const row = orgSheet.getRow(i + 1);
    row.getCell(1).value = f.label;
    row.getCell(1).font = { bold: true };
    row.getCell(2).value = '';
    if (f.key === 'org_constitution') {
      (orgSheet as any).dataValidations.add(`B${i + 1}:B${i + 1}`, {
        type: 'list',
        allowBlank: true,
        formulae: [`"${orgConstitutionLabels.join(',')}"`],
        showErrorMessage: true,
        errorTitle: 'Invalid value',
        error: 'Select a value from the list (same as UI dropdown).',
      });
    }
  });

  // Sheet 2: Entity List – for /admin/entities
  const entityListSheet = workbook.addWorksheet('Entity List', {
    headerFooter: { firstHeader: 'OrgIt Settings - Entity List' },
  });
  const entityListCols = [
    { header: 'NAME OF THE CLIENT', key: 'name', width: 28 },
    { header: 'ENTITY TYPE', key: 'entity_type', width: 18 },
    { header: 'COST CENTRE', key: 'cost_centre_name', width: 18 },
    { header: 'DEPOT', key: 'depot_name', width: 18 },
    { header: 'WAREHOUSE', key: 'warehouse_name', width: 18 },
    { header: 'PAN', key: 'pan', width: 16 },
    { header: 'REPORTING PARTNER', key: 'reporting_partner_mobile', width: 20, style: { numFmt: '@' } as any },
    ...complianceHeaders.map((h, i) => ({ header: h, key: `col_${i}`, width: Math.min(28, h.length + 2) })),
  ];
  entityListSheet.columns = entityListCols;
  entityListSheet.getRow(1).font = { bold: true };
  const freqList = TASK_FREQUENCIES.join(',');
  // Dropdown only for compliance columns (after fixed entity columns).
  for (let c = 8; c <= entityListCols.length; c++) {
    const range = `${getExcelColLetter(c)}2:${getExcelColLetter(c)}1000`;
    (entityListSheet as any).dataValidations.add(range, {
      type: 'list',
      allowBlank: true,
      formulae: [`"${freqList}"`],
      showErrorMessage: true,
      errorTitle: 'Invalid value',
      error: 'Select a frequency from the list (same as UI).',
    });
  }

  // Sheet 3: Service List – for /admin/services
  const serviceListSheet = workbook.addWorksheet('Service List', {
    headerFooter: { firstHeader: 'OrgIt Settings - Service List' },
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

  // Sheet 4: Tasks – manual create-task fields as bulk upload columns
  // Note: this does not change entity-master upload processing; it's a template convenience sheet.
  const tasksSheet = workbook.addWorksheet('Tasks', {
    headerFooter: { firstHeader: 'OrgIt Settings - Tasks' },
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
  ];
  tasksSheet.getRow(1).font = { bold: true };
  // Keep assignee / reporting / owner as text to avoid Excel number corruption.
  tasksSheet.getColumn(3).numFmt = '@'; // Assigned To
  tasksSheet.getColumn(4).numFmt = '@'; // Reporting Member
  tasksSheet.getColumn(10).numFmt = '@'; // Task Owner
  const taskTypeList = 'one_time,recurring';
  const recurrenceList = 'Weekly,Monthly,Quarterly,Yearly';
  // Task Type is column H; Recurrence is column I (same as task bulk template).
  (tasksSheet as any).dataValidations.add('H2:H1000', {
    type: 'list',
    allowBlank: true,
    formulae: [`"${taskTypeList}"`],
    showErrorMessage: true,
    errorTitle: 'Invalid value',
    error: 'Select one_time or recurring.',
  });
  (tasksSheet as any).dataValidations.add('I2:I1000', {
    type: 'list',
    allowBlank: true,
    formulae: [`"${recurrenceList}"`],
    showErrorMessage: true,
    errorTitle: 'Invalid value',
    error: 'Select Weekly, Monthly, Quarterly, or Yearly.',
  });

  // Sheet 5: Employees – for /admin/users
  const employeesSheet = workbook.addWorksheet('Employees', {
    headerFooter: { firstHeader: 'OrgIt Settings - Employees' },
  });
  employeesSheet.columns = [
    { header: 'NAME OF THE EMPLOYEE', key: 'name', width: 30 },
    { header: 'MOBILE NUMBER', key: 'mobile', width: 18 },
    { header: 'DESIGNATON', key: 'designation', width: 25 },
    { header: 'REPORTING TO', key: 'reporting_to_mobile', width: 18 },
    { header: 'LEVEL', key: 'level', width: 10 },
  ];
  employeesSheet.getRow(1).font = { bold: true };

  // Sheet 5: Cost Centres
  const ccSheet = workbook.addWorksheet('Cost Centres', {
    headerFooter: { firstHeader: 'OrgIt Settings - Cost Centres' },
  });
  ccSheet.columns = [
    { header: 'Cost Centre Name', key: 'name', width: 28 },
    { header: 'Short Name', key: 'short_name', width: 18 },
  ];
  ccSheet.getRow(1).font = { bold: true };

  // Sheet 6: Branches
  const branchesSheet = workbook.addWorksheet('Branches', {
    headerFooter: { firstHeader: 'OrgIt Settings - Branches' },
  });
  branchesSheet.columns = [
    { header: 'Branch Name', key: 'name', width: 28 },
    { header: 'Short Name', key: 'short_name', width: 18 },
    { header: 'Address', key: 'address', width: 40 },
    { header: 'GST Number', key: 'gst_number', width: 20 },
  ];
  branchesSheet.getRow(1).font = { bold: true };

  // Sheet 7: Depot
  const depotSheet = workbook.addWorksheet('Depot', {
    headerFooter: { firstHeader: 'OrgIt Settings - Depot' },
  });
  depotSheet.columns = [
    { header: 'Depot Name', key: 'name', width: 28 },
    { header: 'Short Name', key: 'short_name', width: 18 },
  ];
  depotSheet.getRow(1).font = { bold: true };

  // Sheet 8: Warehouse
  const warehouseSheet = workbook.addWorksheet('Warehouse', {
    headerFooter: { firstHeader: 'OrgIt Settings - Warehouse' },
  });
  warehouseSheet.columns = [
    { header: 'Warehouse Name', key: 'name', width: 28 },
    { header: 'Short Name', key: 'short_name', width: 18 },
    { header: 'Address', key: 'address', width: 40 },
    { header: 'GST Number', key: 'gst_number', width: 20 },
  ];
  warehouseSheet.getRow(1).font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();
  console.log('[EntityMasterTemplate] Built OrgIt Settings workbook (9 sheets: Entity Master Data (Org), Entity List, Service List, Tasks, Employees, Cost Centres, Branches, Depot, Warehouse)');
  return buffer as ExcelJS.Buffer;
}

/**
 * Build Excel template with only the Entity Master Data (Organisation) sheet.
 * Single sheet for use on /admin/entity-master page. Same sheet name as in OrgIt Settings workbook.
 */
export async function buildEntityMasterOnlyTemplate(): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OrgIt Entity Master';
  workbook.created = new Date();

  const orgSheet = workbook.addWorksheet('Entity Master Data (Org)', {
    headerFooter: { firstHeader: 'Entity Master Data - Organisation' },
  });
  orgSheet.getColumn(1).width = 28;
  orgSheet.getColumn(2).width = 40;
  const orgConstitutionLabelsSingle = ORG_CONSTITUTION_OPTIONS.map((o) => o.label);
  ENTITY_MASTER_TEMPLATE_VERTICAL_FIELDS.forEach((f, i) => {
    const row = orgSheet.getRow(i + 1);
    row.getCell(1).value = f.label;
    row.getCell(1).font = { bold: true };
    row.getCell(2).value = '';
    if (f.key === 'org_constitution') {
      (orgSheet as any).dataValidations.add(`B${i + 1}:B${i + 1}`, {
        type: 'list',
        allowBlank: true,
        formulae: [`"${orgConstitutionLabelsSingle.join(',')}"`],
        showErrorMessage: true,
        errorTitle: 'Invalid value',
        error: 'Select a value from the list (same as UI dropdown).',
      });
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  console.log('[EntityMasterTemplate] Built single-sheet Entity Master (Organisation) template');
  return buffer as ExcelJS.Buffer;
}

/**
 * Build Excel template with only the Employee sheet.
 * Single sheet for use on /admin/users (Employee management) page.
 * Same column headers and order as full template: NAME OF THE EMPLOYEE, MOBILE NUMBER, DESIGNATON, REPORTING TO, LEVEL.
 */
export async function buildEmployeeOnlyTemplate(): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OrgIt Employees';
  workbook.created = new Date();

  const employeesSheet = workbook.addWorksheet('Employees', {
    headerFooter: { firstHeader: 'Employee Management - Bulk Upload' },
  });
  employeesSheet.columns = [
    { header: 'NAME OF THE EMPLOYEE', key: 'name', width: 30 },
    { header: 'MOBILE NUMBER', key: 'mobile', width: 18 },
    { header: 'DESIGNATON', key: 'designation', width: 25 },
    { header: 'REPORTING TO', key: 'reporting_to_mobile', width: 18 },
    { header: 'LEVEL', key: 'level', width: 10 },
  ];
  employeesSheet.getRow(1).font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();
  console.log('[EntityMasterTemplate] Built single-sheet Employee template');
  return buffer as ExcelJS.Buffer;
}

/**
 * Build Excel template with only the Service List sheet.
 * Single sheet for /admin/services. Columns: RECURRING TASK TITLE/SERVICE LIST, FREQUENCY, TASK ROLL OUT, ONE TIME TASK LIST.
 * FREQUENCY dropdown: same as UI (Daily, Weekly, Fortnightly, Monthly, Quarterly, Half Yearly, Yearly, NA, Custom).
 * TASK ROLL OUT dropdown: End of Period, 1 Month Before Period End.
 */
export async function buildServiceListOnlyTemplate(): Promise<ExcelJS.Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OrgIt Service List';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Service List', {
    headerFooter: { firstHeader: 'Service List - Bulk Upload' },
  });
  sheet.columns = [
    { header: 'RECURRING TASK TITLE/SERVICE LIST', key: 'recurring_title', width: 35 },
    { header: 'FREQUENCY', key: 'frequency', width: 18 },
    { header: 'TASK ROLL OUT', key: 'rollout_rule', width: 28 },
    { header: 'ONE TIME TASK LIST', key: 'one_time_title', width: 30 },
  ];
  sheet.getRow(1).font = { bold: true };

  // FREQUENCY dropdown: same values and order as UI
  sheet.dataValidations.add('B2:B1000', {
    type: 'list',
    allowBlank: true,
    formulae: [`"${TASK_FREQUENCIES.join(',')}"`],
    showErrorMessage: true,
    errorTitle: 'Invalid value',
    error: 'Select a value from the list (same as UI).',
  });

  // TASK ROLL OUT dropdown: same as UI display
  const rolloutLabels = ['End of Period', '1 Month Before Period End'];
  sheet.dataValidations.add('C2:C1000', {
    type: 'list',
    allowBlank: true,
    formulae: [`"${rolloutLabels.join(',')}"`],
    showErrorMessage: true,
    errorTitle: 'Invalid value',
    error: 'Select End of Period or 1 Month Before Period End.',
  });

  const buffer = await workbook.xlsx.writeBuffer();
  console.log('[EntityMasterTemplate] Built single-sheet Service List template');
  return buffer as ExcelJS.Buffer;
}

/**
 * Build Excel template with only the Entity List sheet.
 * Compliance columns come from task_services (recurring) in DB only; no initial list.
 * Except first 3, compliance columns have frequency dropdown: Daily, Weekly, Fortnightly, Monthly, etc.
 */
export async function buildEntityListOnlyTemplate(): Promise<ExcelJS.Buffer> {
  const complianceHeaders = await getRecurringTaskServiceTitles(null);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'OrgIt Entity List';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Entity List', {
    headerFooter: { firstHeader: 'Entity List - Bulk Upload' },
  });
  const cols = [
    { header: 'NAME OF THE CLIENT', key: 'name', width: 28 },
    { header: 'ENTITY TYPE', key: 'entity_type', width: 18 },
    { header: 'COST CENTRE', key: 'cost_centre_name', width: 18 },
    { header: 'DEPOT', key: 'depot_name', width: 18 },
    { header: 'WAREHOUSE', key: 'warehouse_name', width: 18 },
    { header: 'PAN', key: 'pan', width: 16 },
    { header: 'REPORTING PARTNER', key: 'reporting_partner_mobile', width: 20, style: { numFmt: '@' } as any },
    ...complianceHeaders.map((h, i) => ({ header: h, key: `col_${i}`, width: Math.min(28, h.length + 2) })),
  ];
  sheet.columns = cols;
  sheet.getRow(1).font = { bold: true };

  // Dropdown for all compliance columns (after fixed entity columns)
  const freqList = TASK_FREQUENCIES.join(',');
  for (let c = 8; c <= cols.length; c++) {
    const range = `${getExcelColLetter(c)}2:${getExcelColLetter(c)}1000`;
    (sheet as any).dataValidations.add(range, {
      type: 'list',
      allowBlank: true,
      formulae: [`"${freqList}"`],
      showErrorMessage: true,
      errorTitle: 'Invalid value',
      error: 'Select a frequency from the list (same as UI).',
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  console.log('[EntityMasterTemplate] Built single-sheet Entity List template');
  return buffer as ExcelJS.Buffer;
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

async function resolveCostCentreId(client: any, organizationId: string, ccName: string): Promise<string | null> {
  if (!ccName || !organizationId) return null;
  const r = await client.query(
    'SELECT id FROM cost_centres WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
    [organizationId, ccName]
  );
  return r.rows.length > 0 ? r.rows[0].id : null;
}

async function resolveDepotId(client: any, organizationId: string, depotName: string): Promise<string | null> {
  if (!depotName || !organizationId) return null;
  try {
    const r = await client.query(
      'SELECT id FROM depots WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
      [organizationId, depotName]
    );
    return r.rows.length > 0 ? r.rows[0].id : null;
  } catch (err: any) {
    if (err.code === '42P01') return null; // depots table does not exist
    throw err;
  }
}

async function resolveWarehouseId(client: any, organizationId: string, warehouseName: string): Promise<string | null> {
  if (!warehouseName || !organizationId) return null;
  try {
    const r = await client.query(
      'SELECT id FROM warehouses WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
      [organizationId, warehouseName]
    );
    return r.rows.length > 0 ? r.rows[0].id : null;
  } catch (err: any) {
    if (err.code === '42P01') return null; // warehouses table does not exist
    throw err;
  }
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
  _userId: string,
  userOrganizationId: string | null,
  isSuperAdmin: boolean
): Promise<UploadResult> {
  const result: UploadResult = {
    updated: { organizations: 0, cost_centres: 0, branches: 0, depots: 0, warehouses: 0, task_services: 0, client_entities: 0, client_entity_services: 0, employees: 0 },
    errors: [],
  };

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer as any);

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
    const costCentreCache = new Map<string, string>();
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
    const resolveCostCentreCached = async (organizationId: string, ccName: string): Promise<string | null> => {
      const key = `cc|${organizationId}|${(ccName || '').trim().toLowerCase()}`;
      if (!ccName?.trim()) return null;
      if (costCentreCache.has(key)) return costCentreCache.get(key)!;
      const id = await resolveCostCentreId(client, organizationId, ccName);
      if (id) costCentreCache.set(key, id);
      return id;
    };
    const resolveDepotCached = async (organizationId: string, depotName: string): Promise<string | null> => {
      const key = `depot|${organizationId}|${(depotName || '').trim().toLowerCase()}`;
      if (!depotName?.trim()) return null;
      if (costCentreCache.has(key)) return costCentreCache.get(key)!; // reuse cache map
      const id = await resolveDepotId(client, organizationId, depotName);
      if (id) costCentreCache.set(key, id);
      return id;
    };
    const resolveWarehouseCached = async (organizationId: string, warehouseName: string): Promise<string | null> => {
      const key = `wh|${organizationId}|${(warehouseName || '').trim().toLowerCase()}`;
      if (!warehouseName?.trim()) return null;
      if (costCentreCache.has(key)) return costCentreCache.get(key)!;
      const id = await resolveWarehouseId(client, organizationId, warehouseName);
      if (id) costCentreCache.set(key, id);
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

    // --- Organizations: sheet name matches /admin/entity-master (Entity Master Data (Org)) ---
    const orgSheet = getSheet([
      'Entity Master Data (Org)',
      'Entity Master (Organisation)',
      'ENTITY MASTER DATA (Organisati',
      'ENTITY MASTER DATA (Organisation)',
      'Organizations',
    ]);
    console.log('[EntityMasterUpload] Organisation sheet', orgSheet ? { name: orgSheet.name, rowCount: orgSheet.rowCount } : 'NOT FOUND');
    if (orgSheet && orgSheet.rowCount >= 1) {
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
            if (key === 'depot_count' || key === 'warehouse_count') {
              const num = !cellBStr ? null : parseInt(cellBStr, 10);
              vals[key] = Number.isNaN(num) ? null : num;
            } else {
              vals[key] = cellBStr === '' ? '' : cellBStr;
            }
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
                const depot_count = (vals.depot_count != null && typeof vals.depot_count === 'number') ? vals.depot_count : 0;
                const warehouse_count = (vals.warehouse_count != null && typeof vals.warehouse_count === 'number') ? vals.warehouse_count : 0;
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
                  org_constitution = NULLIF($7,''), pan = $8, gst = $9, cin = NULLIF($10,''), depot_count = COALESCE($11,0), warehouse_count = COALESCE($12,0),
                  country_id = $13, state_id = $14, city_id = $15, pin_code = NULLIF($16,''), address_line1 = NULLIF($17,''), address_line2 = NULLIF($18,''),
                  updated_at = CURRENT_TIMESTAMP
                  WHERE id = $19`,
                  [name, short_name || null, address || null, email || null, website || null, phone_number || null, org_constitution || null, pan || null, gst || null, cin || null, depot_count, warehouse_count, country_id, state_id, city_id, pin_code || null, address_line1 || null, address_line2 || null, orgId]
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
                const depot_count = (vals.depot_count != null && typeof vals.depot_count === 'number') ? vals.depot_count : 0;
                const warehouse_count = (vals.warehouse_count != null && typeof vals.warehouse_count === 'number') ? vals.warehouse_count : 0;
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
                  org_constitution = NULLIF($7,''), pan = $8, gst = $9, cin = NULLIF($10,''), depot_count = COALESCE($11,0), warehouse_count = COALESCE($12,0),
                  country_id = $13, state_id = $14, city_id = $15, pin_code = NULLIF($16,''), address_line1 = NULLIF($17,''), address_line2 = NULLIF($18,''),
                  updated_at = CURRENT_TIMESTAMP
                  WHERE id = $19`,
                  [name, short_name || null, address || null, email || null, website || null, phone_number || null, org_constitution || null, pan || null, gst || null, cin || null, depot_count, warehouse_count, country_id, state_id, city_id, pin_code || null, address_line1 || null, address_line2 || null, orgId]
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
          const depotCol = colAny(headers, 'depot_count', 'depot');
          const warehouseCol = colAny(headers, 'warehouse_count', 'warehouse');
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
              const depot_count = depotCol >= 0 ? getCellNum(row, depotCol) : null;
              const warehouse_count = warehouseCol >= 0 ? getCellNum(row, warehouseCol) : null;
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
                org_constitution = NULLIF($7,''), pan = $8, gst = $9, cin = NULLIF($10,''), depot_count = COALESCE($11,0), warehouse_count = COALESCE($12,0),
                country_id = $13, state_id = $14, city_id = $15, pin_code = NULLIF($16,''), address_line1 = NULLIF($17,''), address_line2 = NULLIF($18,''),
                updated_at = CURRENT_TIMESTAMP
                WHERE id = $19`,
                [name, short_name || null, address || null, email || null, website || null, phone_number || null, org_constitution || null, pan || null, gst || null, cin || null, depot_count ?? 0, warehouse_count ?? 0, country_id, state_id, city_id, pin_code || null, address_line1 || null, address_line2 || null, orgId]
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
    } else if (!orgSheet) {
      console.log('[EntityMasterUpload] Organisation sheet missing or empty – no organisation rows processed');
    }

    // --- Cost centres (Cost Centres or legacy Cost centres) ---
    const ccSheet = getSheet(['Cost Centres', 'Cost centres']);
    console.log('[EntityMasterUpload] Cost Centres sheet', ccSheet ? { name: ccSheet.name, rowCount: ccSheet.rowCount } : 'NOT FOUND');
    if (ccSheet && ccSheet.rowCount >= 2) {
      const headers = ccSheet.getRow(1).values as any[];
      // Accept both old technical headers and new UI labels from the template.
      const nameIdx = headers.findIndex((h: any) => {
        const v = String(h || '').trim().toLowerCase();
        return v === 'name' || v === 'cost centre name' || v === 'cost center name';
      });
      const orgNameIdx = headers.findIndex((h: any) => String(h || '').trim().toLowerCase() === 'organization_name');
      const shortNameIdx = headers.findIndex((h: any) => {
        const v = String(h || '').trim().toLowerCase();
        return v === 'short_name' || v === 'short name';
      });
      const displayOrderIdx = headers.findIndex((h: any) => {
        const v = String(h || '').trim().toLowerCase();
        return v === 'display_order' || v === 'display order';
      });
      if (nameIdx >= 0) {
        const maxRow = lastRow(ccSheet);
        if (hasMoreThanMaxRows(ccSheet))
          pushError({ sheet: ccSheet.name, message: `Sheet has more than ${MAX_ROWS_PER_SHEET} rows; only first ${MAX_ROWS_PER_SHEET} processed.` });
        for (let r = 2; r <= maxRow; r++) {
          try {
            const row = ccSheet.getRow(r);
            if (isRowEmpty(row, [nameIdx])) continue;
            const name = getCellStrMax(row, nameIdx, NAME_MAX);
            if (!name) continue;
            let orgId = defaultOrgId;
            if (isSuperAdmin && orgNameIdx >= 0) {
              const on = getCellStr(row, orgNameIdx);
              if (on) orgId = await resolveOrgIdCached(on);
            }
            if (!orgId) continue;
            const shortName = shortNameIdx >= 0 ? getCellStrMax(row, shortNameIdx, NAME_MAX) : '';
            const displayOrder = displayOrderIdx >= 0 ? getCellNum(row, displayOrderIdx) : 0;
            const existing = await client.query(
              'SELECT id FROM cost_centres WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
              [orgId, name]
            );
            if (existing.rows.length > 0) {
              await client.query(
                'UPDATE cost_centres SET short_name = $1, display_order = COALESCE($2,0), updated_at = CURRENT_TIMESTAMP WHERE id = $3',
                [shortName || null, displayOrder ?? 0, existing.rows[0].id]
              );
            } else {
              await client.query(
                'INSERT INTO cost_centres (organization_id, name, short_name, display_order) VALUES ($1, $2, $3, COALESCE($4,0))',
                [orgId, name, shortName || null, displayOrder ?? 0]
              );
            }
            result.updated.cost_centres += 1;
          } catch (err: any) {
            pushError({ sheet: ccSheet.name, row: r, message: err?.message ?? String(err) });
          }
        }
        console.log('[EntityMasterUpload] Cost Centres processed', { updated: result.updated.cost_centres });
      }
    }

    // --- Branches ---
    const branchesSheet = workbook.getWorksheet('Branches');
    console.log('[EntityMasterUpload] Branches sheet', branchesSheet ? { name: branchesSheet.name, rowCount: branchesSheet.rowCount } : 'NOT FOUND');
    if (branchesSheet && branchesSheet.rowCount >= 2) {
      const headers = branchesSheet.getRow(1).values as any[];
      const nameIdx = headers.findIndex((h: any) => {
        const v = String(h || '').trim().toLowerCase();
        return v === 'name' || v === 'branch name';
      });
      const orgNameIdx = headers.findIndex((h: any) => String(h || '').trim().toLowerCase() === 'organization_name');
      const shortNameIdx = headers.findIndex((h: any) => {
        const v = String(h || '').trim().toLowerCase();
        return v === 'short_name' || v === 'short name';
      });
      const addressIdx = headers.findIndex((h: any) => {
        const v = String(h || '').trim().toLowerCase();
        return v === 'address';
      });
      const gstNumberIdx = headers.findIndex((h: any) => {
        const v = String(h || '').trim().toLowerCase();
        return v === 'gst_number' || v === 'gst number';
      });
      if (nameIdx >= 0) {
        const maxRow = lastRow(branchesSheet);
        if (hasMoreThanMaxRows(branchesSheet))
          pushError({ sheet: branchesSheet.name, message: `Sheet has more than ${MAX_ROWS_PER_SHEET} rows; only first ${MAX_ROWS_PER_SHEET} processed.` });
        for (let r = 2; r <= maxRow; r++) {
          try {
            const row = branchesSheet.getRow(r);
            if (isRowEmpty(row, [nameIdx])) continue;
            const name = getCellStrMax(row, nameIdx, NAME_MAX);
            if (!name) continue;
            let orgId = defaultOrgId;
            if (isSuperAdmin && orgNameIdx >= 0) {
              const on = getCellStr(row, orgNameIdx);
              if (on) orgId = await resolveOrgIdCached(on);
            }
            if (!orgId) continue;
            const shortName = shortNameIdx >= 0 ? getCellStrMax(row, shortNameIdx, NAME_MAX) : '';
            const address = addressIdx >= 0 ? getCellStrMax(row, addressIdx, STRING_MAX) : '';
            const gst_number = gstNumberIdx >= 0 ? getCellStr(row, gstNumberIdx) : '';
            const existing = await client.query(
              'SELECT id FROM branches WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
              [orgId, name]
            );
            if (existing.rows.length > 0) {
              await client.query(
                'UPDATE branches SET short_name = $1, address = $2, gst_number = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
                [shortName || null, address || null, gst_number || null, existing.rows[0].id]
              );
            } else {
              await client.query(
                'INSERT INTO branches (organization_id, name, short_name, address, gst_number) VALUES ($1, $2, $3, $4, $5)',
                [orgId, name, shortName || null, address || null, gst_number || null]
              );
            }
            result.updated.branches += 1;
          } catch (err: any) {
            pushError({ sheet: branchesSheet.name, row: r, message: err?.message ?? String(err) });
          }
        }
        console.log('[EntityMasterUpload] Branches processed', { updated: result.updated.branches });
      }
    }

    // --- Depot ---
    const depotSheet = getSheet(['Depot', 'Depots']);
    if (depotSheet && depotSheet.rowCount >= 2) {
      const headers = depotSheet.getRow(1).values as any[];
      const nameIdx = headers.findIndex((h: any) => {
        const v = String(h || '').trim().toLowerCase();
        return v === 'name' || v === 'depot name';
      });
      const orgNameIdx = headers.findIndex((h: any) => String(h || '').trim().toLowerCase() === 'organization_name');
      const shortNameIdx = headers.findIndex((h: any) => {
        const v = String(h || '').trim().toLowerCase();
        return v === 'short_name' || v === 'short name';
      });
      const displayOrderIdx = headers.findIndex((h: any) => {
        const v = String(h || '').trim().toLowerCase();
        return v === 'display_order' || v === 'display order';
      });
      if (nameIdx >= 0) {
        const maxRow = lastRow(depotSheet);
        for (let r = 2; r <= maxRow; r++) {
          try {
            const row = depotSheet.getRow(r);
            if (isRowEmpty(row, [nameIdx])) continue;
            const name = getCellStrMax(row, nameIdx, NAME_MAX);
            if (!name) continue;
            let orgId = defaultOrgId;
            if (isSuperAdmin && orgNameIdx >= 0) {
              const on = getCellStr(row, orgNameIdx);
              if (on) orgId = await resolveOrgIdCached(on);
            }
            if (!orgId) continue;
            const shortName = shortNameIdx >= 0 ? getCellStrMax(row, shortNameIdx, NAME_MAX) : '';
            const displayOrder = displayOrderIdx >= 0 ? getCellNum(row, displayOrderIdx) : 0;
            const existing = await client.query(
              'SELECT id FROM depots WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
              [orgId, name]
            );
            if (existing.rows.length > 0) {
              await client.query(
                'UPDATE depots SET short_name = $1, display_order = COALESCE($2,0), updated_at = CURRENT_TIMESTAMP WHERE id = $3',
                [shortName || null, displayOrder ?? 0, existing.rows[0].id]
              );
            } else {
              await client.query(
                'INSERT INTO depots (organization_id, name, short_name, display_order) VALUES ($1, $2, $3, COALESCE($4,0))',
                [orgId, name, shortName || null, displayOrder ?? 0]
              );
            }
            result.updated.depots += 1;
          } catch (err: any) {
            if (err?.code !== '42P01') pushError({ sheet: depotSheet.name, row: r, message: err?.message ?? String(err) });
          }
        }
        console.log('[EntityMasterUpload] Depot processed', { updated: result.updated.depots });
      }
    }

    // --- Warehouse ---
    const warehouseSheet = getSheet(['Warehouse', 'Warehouses']);
    if (warehouseSheet && warehouseSheet.rowCount >= 2) {
      const headers = warehouseSheet.getRow(1).values as any[];
      const nameIdx = headers.findIndex((h: any) => {
        const v = String(h || '').trim().toLowerCase();
        return v === 'name' || v === 'warehouse name';
      });
      const orgNameIdx = headers.findIndex((h: any) => String(h || '').trim().toLowerCase() === 'organization_name');
      const shortNameIdx = headers.findIndex((h: any) => {
        const v = String(h || '').trim().toLowerCase();
        return v === 'short_name' || v === 'short name';
      });
      const addressIdx = headers.findIndex((h: any) => {
        const v = String(h || '').trim().toLowerCase();
        return v === 'address';
      });
      const gstNumberIdx = headers.findIndex((h: any) => {
        const v = String(h || '').trim().toLowerCase();
        return v === 'gst_number' || v === 'gst number';
      });
      if (nameIdx >= 0) {
        const maxRow = lastRow(warehouseSheet);
        for (let r = 2; r <= maxRow; r++) {
          try {
            const row = warehouseSheet.getRow(r);
            if (isRowEmpty(row, [nameIdx])) continue;
            const name = getCellStrMax(row, nameIdx, NAME_MAX);
            if (!name) continue;
            let orgId = defaultOrgId;
            if (isSuperAdmin && orgNameIdx >= 0) {
              const on = getCellStr(row, orgNameIdx);
              if (on) orgId = await resolveOrgIdCached(on);
            }
            if (!orgId) continue;
            const shortName = shortNameIdx >= 0 ? getCellStrMax(row, shortNameIdx, NAME_MAX) : '';
            const address = addressIdx >= 0 ? getCellStrMax(row, addressIdx, STRING_MAX) : '';
            const gst_number = gstNumberIdx >= 0 ? getCellStr(row, gstNumberIdx) : '';
            const existing = await client.query(
              'SELECT id FROM warehouses WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
              [orgId, name]
            );
            if (existing.rows.length > 0) {
              await client.query(
                'UPDATE warehouses SET short_name = $1, address = $2, gst_number = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
                [shortName || null, address || null, gst_number || null, existing.rows[0].id]
              );
            } else {
              await client.query(
                'INSERT INTO warehouses (organization_id, name, short_name, address, gst_number) VALUES ($1, $2, $3, $4, $5)',
                [orgId, name, shortName || null, address || null, gst_number || null]
              );
            }
            result.updated.warehouses += 1;
          } catch (err: any) {
            if (err?.code !== '42P01') pushError({ sheet: warehouseSheet.name, row: r, message: err?.message ?? String(err) });
          }
        }
        console.log('[EntityMasterUpload] Warehouse processed', { updated: result.updated.warehouses });
      }
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
    const clientSheet = getSheet(['Entity List', 'Client Entities', 'Client entities']);
    console.log('[EntityMasterUpload] Entity List / Client Entities sheet', clientSheet ? { name: clientSheet.name, rowCount: clientSheet.rowCount } : 'NOT FOUND');
    if (clientSheet && clientSheet.rowCount >= 2) {
      const headers = clientSheet.getRow(1).values as any[];
      const nameIdx = colAny(headers, 'name', 'name of the client');
      const orgNameIdx = colAny(headers, 'organization_name');
      const entityTypeIdx = colAny(headers, 'entity_type', 'entity type');
      const costCentreNameIdx = colAny(headers, 'cost_centre_name', 'cost centre');
      const depotNameIdx = colAny(headers, 'depot_name', 'depot');
      const warehouseNameIdx = colAny(headers, 'warehouse_name', 'warehouse');
      const panIdx = colAny(headers, 'pan');
      const reportingPartnerIdx = colAny(headers, 'reporting_partner_mobile', 'reporting partner', 'reporting_partner');
      // Compliance columns: header (trimmed) -> { colIndex, taskServiceTitle } from task_services (recurring) only
      const allowedTitles = await getRecurringTaskServiceTitlesForEntityList(defaultOrgId, client);
      const complianceCols: Array<{ colIndex: number; taskServiceTitle: string }> = [];
      for (let i = 1; i < (headers?.length ?? 0); i++) {
        const h = String(headers[i] ?? '').trim();
        if (!h) continue;
        const match = allowedTitles.find((t) => t.toLowerCase() === h.toLowerCase());
        if (match) complianceCols.push({ colIndex: i, taskServiceTitle: match });
      }
      if (nameIdx >= 0) {
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
            const cost_centre_name = costCentreNameIdx >= 0 ? getCellStr(row, costCentreNameIdx) : '';
            const depot_name = depotNameIdx >= 0 ? getCellStr(row, depotNameIdx) : '';
            const warehouse_name = warehouseNameIdx >= 0 ? getCellStr(row, warehouseNameIdx) : '';
            const pan = panIdx >= 0 ? getCellStrMax(row, panIdx, 50) : '';
            const reporting_partner_mobile = reportingPartnerIdx >= 0 ? getCellStrMax(row, reportingPartnerIdx, PHONE_PIN_MAX) : '';
            let cost_centre_id: string | null = null;
            let depot_id: string | null = null;
            let warehouse_id: string | null = null;
            if (cost_centre_name) cost_centre_id = await resolveCostCentreCached(orgId, cost_centre_name);
            if (depot_name) depot_id = await resolveDepotCached(orgId, depot_name);
            if (warehouse_name) warehouse_id = await resolveWarehouseCached(orgId, warehouse_name);
            const existing = await client.query(
              'SELECT id FROM client_entities WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
              [orgId, name]
            );
            if (existing.rows.length > 0) {
              await client.query(
                "UPDATE client_entities SET entity_type = NULLIF($1, ''), cost_centre_id = $2, depot_id = $3, warehouse_id = $4, pan = NULLIF($5, ''), reporting_partner_mobile = NULLIF($6, ''), updated_at = CURRENT_TIMESTAMP WHERE id = $7",
                [entity_type || null, cost_centre_id, depot_id, warehouse_id, pan || null, reporting_partner_mobile || null, existing.rows[0].id]
              );
            } else {
              await client.query(
                "INSERT INTO client_entities (organization_id, name, entity_type, cost_centre_id, depot_id, warehouse_id, pan, reporting_partner_mobile) VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, NULLIF($7, ''), NULLIF($8, ''))",
                [orgId, name, entity_type || null, cost_centre_id, depot_id, warehouse_id, pan || null, reporting_partner_mobile || null]
              );
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

    // --- Employees (NAME OF THE EMPLOYEE, MOBILE NUMBER, DEPARTMENT, DESIGNATION, REPORTING TO, LEVEL; Department & Designation not mandatory) ---
    const employeesSheet = workbook.getWorksheet('Employees');
    console.log('[EntityMasterUpload] Employees sheet', employeesSheet ? { name: employeesSheet.name, rowCount: employeesSheet.rowCount, defaultOrgId } : 'NOT FOUND');
    if (employeesSheet && employeesSheet.rowCount >= 2 && defaultOrgId) {
      const headers = employeesSheet.getRow(1).values as any[];
      const mobileIdx = colAny(headers, 'mobile', 'mobile number');
      const nameIdx = colAny(headers, 'name', 'name of the employee');
      const deptIdx = col(headers, 'department');
      const desigIdx = colAny(headers, 'designation', 'designaton');
      const reportIdx = colAny(headers, 'reporting_to_mobile', 'reporting to');
      const levelIdx = colAny(headers, 'level');
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
            const department = deptIdx >= 0 ? getCellStrMax(row, deptIdx, NAME_MAX) : '';
            const designation = desigIdx >= 0 ? getCellStrMax(row, desigIdx, NAME_MAX) : '';
            const reporting_to_value = reportIdx >= 0 ? getCellStr(row, reportIdx) : '';
            const level = levelIdx >= 0 ? getCellStrMax(row, levelIdx, 50) : '';
            // REPORTING TO: accept manager mobile or manager name (same org)
            let reporting_to: string | null = null;
            if (reporting_to_value?.trim()) {
              reporting_to = await resolveReportingToByMobileOrName(client, defaultOrgId, reporting_to_value);
            }
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
            await client.query(
              `INSERT INTO user_organizations (user_id, organization_id, department, designation, reporting_to, level, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT (user_id, organization_id) DO UPDATE SET department = $3, designation = $4, reporting_to = $5, level = $6, updated_at = CURRENT_TIMESTAMP`,
              [employeeUserId, defaultOrgId, department || null, designation || null, reporting_to, level || null]
            );
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
  department: string | null;
  designation: string | null;
  reporting_to_user_id: string | null;
  level: string | null;
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
  cost_centre_id: string | null;
  depot_id: string | null;
  warehouse_id: string | null;
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
  const deptIdx = col(headers, 'department');
  const desigIdx = colAny(headers, 'designation', 'designaton');
  const reportIdx = colAny(headers, 'reporting_to_mobile', 'reporting to');
  const levelIdx = colAny(headers, 'level');
  if (mobileIdx < 0 || nameIdx < 0) return [];
  const payloads: EmployeeJobPayload[] = [];
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
    const department = deptIdx >= 0 ? getCellStrMax(row, deptIdx, NAME_MAX) : '';
    const designation = desigIdx >= 0 ? getCellStrMax(row, desigIdx, NAME_MAX) : '';
    const reporting_to_value = reportIdx >= 0 ? getCellStr(row, reportIdx) : '';
    const level = levelIdx >= 0 ? getCellStrMax(row, levelIdx, 50) : '';
    const reporting_to_user_id = reporting_to_value?.trim()
      ? await resolveReportingToByMobileOrName(client, organizationId, reporting_to_value)
      : null;
    payloads.push({
      mobile_normalized: mobileNorm,
      name: name || 'Employee',
      department: department || null,
      designation: designation || null,
      reporting_to_user_id,
      level: level || null,
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
  const sheet = workbook.getWorksheet('Entity List') ?? workbook.getWorksheet('Client Entities');
  if (!sheet || (sheet.rowCount ?? 0) < 2) return [];
  const headers = sheet.getRow(1).values as any[];
  const nameIdx = colAny(headers, 'name', 'name of the client');
  const orgNameIdx = colAny(headers, 'organization_name');
  const entityTypeIdx = colAny(headers, 'entity_type', 'entity type');
  const costCentreNameIdx = colAny(headers, 'cost_centre_name', 'cost centre');
  const depotNameIdx = colAny(headers, 'depot_name', 'depot');
  const warehouseNameIdx = colAny(headers, 'warehouse_name', 'warehouse');
  const panIdx = colAny(headers, 'pan');
  const reportingPartnerIdx = colAny(headers, 'reporting_partner_mobile', 'reporting partner', 'reporting_partner');
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
    const cost_centre_name = costCentreNameIdx >= 0 ? getCellStr(row, costCentreNameIdx) : '';
    const depot_name = depotNameIdx >= 0 ? getCellStr(row, depotNameIdx) : '';
    const warehouse_name = warehouseNameIdx >= 0 ? getCellStr(row, warehouseNameIdx) : '';
    const pan = panIdx >= 0 ? getCellStrMax(row, panIdx, 50) : '';
    const reporting_partner_mobile = reportingPartnerIdx >= 0 ? getCellStrMax(row, reportingPartnerIdx, PHONE_PIN_MAX) : '';
    const cost_centre_id = cost_centre_name ? await resolveCostCentreId(client, orgId, cost_centre_name) : null;
    const depot_id = depot_name ? await resolveDepotId(client, orgId, depot_name) : null;
    const warehouse_id = warehouse_name ? await resolveWarehouseId(client, orgId, warehouse_name) : null;
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
      cost_centre_id,
      depot_id: depot_id ?? null,
      warehouse_id: warehouse_id ?? null,
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
  const { mobile_normalized, name, department, designation, reporting_to_user_id, level } = payload;
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
  await client.query(
    `INSERT INTO user_organizations (user_id, organization_id, department, designation, reporting_to, level, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, organization_id) DO UPDATE SET department = $3, designation = $4, reporting_to = $5, level = $6, updated_at = CURRENT_TIMESTAMP`,
    [employeeUserId, organizationId, department || null, designation || null, reporting_to_user_id, level || null]
  );
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
  const { organization_id, name, entity_type, cost_centre_id, depot_id, warehouse_id, pan, reporting_partner_mobile, compliance } = payload;
  const orgId = organization_id || _organizationId;
  const nameTrim = (name || '').trim();
  if (!nameTrim) throw new Error('Client entity name is required');
  const NAME_MAX = 255;
  const nameSafe = nameTrim.slice(0, NAME_MAX);
  const existing = await client.query(
    'SELECT id FROM client_entities WHERE organization_id = $1 AND LOWER(TRIM(name)) = LOWER($2) LIMIT 1',
    [orgId, nameSafe]
  );
  let clientEntityId: string;
  if (existing.rows.length > 0) {
    clientEntityId = existing.rows[0].id;
    await client.query(
      "UPDATE client_entities SET entity_type = NULLIF($1, ''), cost_centre_id = $2, depot_id = $3, warehouse_id = $4, pan = NULLIF($5, ''), reporting_partner_mobile = NULLIF($6, ''), updated_at = CURRENT_TIMESTAMP WHERE id = $7",
      [entity_type || null, cost_centre_id, depot_id ?? null, warehouse_id ?? null, pan || null, reporting_partner_mobile || null, clientEntityId]
    );
  } else {
    const ins = await client.query(
      "INSERT INTO client_entities (organization_id, name, entity_type, cost_centre_id, depot_id, warehouse_id, pan, reporting_partner_mobile) VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, NULLIF($7, ''), NULLIF($8, '')) RETURNING id",
      [orgId, nameSafe, entity_type || null, cost_centre_id, depot_id ?? null, warehouse_id ?? null, pan || null, reporting_partner_mobile || null]
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
