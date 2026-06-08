import ExcelJS from 'exceljs';
import { query } from '../config/database';
import {
  buildStructureSheetPlan,
  formatNodeDisplayLabel,
  getNodeEntityTypeFromMeta,
  ORG_STRUCTURE_DATA_SHEET_NAME,
  ORG_STRUCTURE_TABLE_NAME,
} from './orgStructureBulkTemplate';
import { getActiveLevelsFromL2, loadTreeForBulk } from './orgStructureBulkUtils';
import { getEntityTypeOptionsForSection } from './organizationStructureCatalog';
import type { OrganizationStructureTree } from './organizationStructureService';
import { buildTemplateWorkbook, getRecurringTaskServiceTitles } from './entityMasterBulkService';

export type MasterBulkSampleContext = {
  organizationId: string;
  complianceHeaders: string[];
  tree: OrganizationStructureTree;
  /** Existing org user mobile for REPORTING TO / partner fields */
  reportingPartnerMobile?: string;
  /** Mobile used on Employees + Tasks assignee (created on upload if new) */
  sampleEmployeeMobile?: string;
};

async function loadSamplePhones(organizationId: string): Promise<{
  reportingPartnerMobile: string;
  sampleEmployeeMobile: string;
}> {
  const res = await query(
    `SELECT u.mobile::text AS mobile
     FROM users u
     JOIN user_organizations uo ON uo.user_id = u.id
     WHERE uo.organization_id = $1 AND u.mobile IS NOT NULL AND TRIM(u.mobile) <> ''
     ORDER BY u.created_at ASC
     LIMIT 1`,
    [organizationId]
  );
  const reportingPartnerMobile = (res.rows?.[0]?.mobile as string | undefined)?.trim() || '+919876543210';
  return {
    reportingPartnerMobile,
    sampleEmployeeMobile: '+919812349999',
  };
}

function pickExistingOrgUnitMapping(tree: OrganizationStructureTree): string | null {
  const levelsFromL2 = getActiveLevelsFromL2(tree);
  const nodes = (tree.nodes || []).filter((n) => n.status === 'active');
  if (!nodes.length) return null;
  const preferred = nodes.find(
    (n) =>
      levelsFromL2.length > 0 &&
      (n.levelLabel || '').trim().toLowerCase() === levelsFromL2[0].levelLabel.trim().toLowerCase()
  );
  const node = preferred || nodes[0];
  return formatNodeDisplayLabel(node, getNodeEntityTypeFromMeta(node));
}

function getOrgRootNode(tree: OrganizationStructureTree) {
  return tree.rootNode || (tree.nodes || []).find((n) => !n.parentNodeId && n.status === 'active') || null;
}

function orgHasRoot(tree: OrganizationStructureTree): boolean {
  return Boolean(tree.summary?.hasRootNode || getOrgRootNode(tree));
}

/** Remove prior SAMPLE_* demo rows so re-generated files do not duplicate failing rows. */
function clearSampleStructureRows(sheet: ExcelJS.Worksheet, fieldNameCol: number): void {
  for (let r = 2; r <= 500; r++) {
    const name = cellToString(sheet.getCell(r, fieldNameCol).value);
    if (!name.toUpperCase().startsWith('SAMPLE_')) continue;
    const row = sheet.getRow(r);
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.value = null;
    });
  }
}

function clearSampleDataRows(sheet: ExcelJS.Worksheet, match: (rowNum: number, text: string) => boolean): void {
  for (let r = 2; r <= 200; r++) {
    let rowText = '';
    sheet.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
      rowText += ` ${cellToString(cell.value)}`;
    });
    if (!rowText.trim()) continue;
    if (match(r, rowText)) {
      sheet.getRow(r).eachCell({ includeEmpty: true }, (cell) => {
        cell.value = null;
      });
    }
  }
}

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

function cellToString(value: ExcelJS.CellValue | null | undefined): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object' && value !== null) {
    if ('result' in value && value.result != null && value.result !== '') {
      return cellToString(value.result as ExcelJS.CellValue);
    }
    if ('text' in value) return String((value as { text?: string }).text ?? '').trim();
    if ('richText' in value && Array.isArray((value as { richText: { text: string }[] }).richText)) {
      return (value as { richText: { text: string }[] }).richText.map((t) => t.text).join('').trim();
    }
  }
  return String(value).trim();
}

function headerIndexMap(sheet: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  const row = sheet.getRow(1);
  row.eachCell({ includeEmpty: false }, (cell, col) => {
    const h = cellToString(cell.value);
    if (h) map.set(h.toLowerCase(), col);
  });
  return map;
}

function setByHeaders(
  sheet: ExcelJS.Worksheet,
  rowNum: number,
  headers: Map<string, number>,
  values: Record<string, string | number>
): void {
  for (const [header, raw] of Object.entries(values)) {
    const col = headers.get(header.toLowerCase());
    if (col != null) sheet.getCell(rowNum, col).value = raw;
  }
}

function firstEmptyDataRow(sheet: ExcelJS.Worksheet, keyCol: number, maxScan = 500): number {
  for (let r = 2; r <= maxScan; r++) {
    if (!cellToString(sheet.getCell(r, keyCol).value)) return r;
  }
  return maxScan + 1;
}

function pickFieldType(section: string, preferred: string): string {
  const options = getEntityTypeOptionsForSection(section);
  const match = options.find((o) => o.toLowerCase() === preferred.toLowerCase());
  return match || options[0] || preferred;
}

function setOrgStructureDisplayLabel(
  sheet: ExcelJS.Worksheet,
  rowNum: number,
  displayCol: number,
  section: string,
  fieldType: string,
  fieldName: string
): void {
  const display = formatNodeDisplayLabel(
    { name: fieldName, levelLabel: section },
    fieldType
  );
  const displayFormula = `IF(C${rowNum}="","",IF(LOWER(B${rowNum})=LOWER(A${rowNum}),C${rowNum},C${rowNum}&" ("&B${rowNum}&")"))`;
  sheet.getCell(rowNum, displayCol).value = { formula: displayFormula, result: display };
}

function updateOrgStructureTableRef(sheet: ExcelJS.Worksheet, lastDataRow: number, totalCols: number): void {
  try {
    const table = sheet.getTable(ORG_STRUCTURE_TABLE_NAME);
    const endCol = getExcelColLetter(totalCols);
    table.ref = `A1:${endCol}${Math.max(2, lastDataRow)}`;
  } catch {
    // Table may be absent on very old workbooks
  }
}

function orgMappingDisplayLabel(section: string, fieldType: string, fieldName: string): string {
  return formatNodeDisplayLabel({ name: fieldName, levelLabel: section }, fieldType);
}

/** Fill Organisation Structure sample rows (exact template columns + detail fields). */
function fillOrganisationStructureSheet(workbook: ExcelJS.Workbook, tree: OrganizationStructureTree): string {
  const sheet = workbook.getWorksheet(ORG_STRUCTURE_DATA_SHEET_NAME);
  const existingMapping = pickExistingOrgUnitMapping(tree);
  if (!sheet) return existingMapping || 'SAMPLE_CompOne (Company)';

  const levels = tree.catalogLevels ?? tree.levels ?? [];
  const plan = buildStructureSheetPlan(tree, levels);
  const levelsFromL2 = getActiveLevelsFromL2(tree);

  const section1 = levelsFromL2[0]?.levelLabel || 'Entity';
  const section2 = levelsFromL2[1]?.levelLabel || 'Region';
  const section3 = levelsFromL2[2]?.levelLabel;

  const type1 = pickFieldType(section1, 'Company');
  const type2 = pickFieldType(section2, 'State');
  const type3 = section3 ? pickFieldType(section3, 'Division') : '';

  clearSampleStructureRows(sheet, plan.columnIndex.fieldName);

  const rootName = 'SAMPLE_CompOne';
  const midName = 'SAMPLE_Andhra';
  const leafName = 'SAMPLE_Operations';
  const existingRoot = getOrgRootNode(tree);

  const detailValues: Record<string, string> = {
    'Short Name': 'Sample Org',
    'Display Name': 'Sample Organisation Pvt Ltd',
    Description: 'Sample bulk upload — organisation structure row',
    Status: 'Active',
    'Effective From': '2024-04-01',
    'Entity Type / Legal Constitution': 'Company',
    'Registration Number': 'U12345AB2020PTC000001',
    CIN: 'U12345AB2020PTC000001',
    PAN: 'AAECS1234A',
    TAN: 'MUMS12345A',
    GSTIN: '29AAECS1234A1Z5',
    'Registered Address Line 1': '123 Sample Street',
    'Registered Address Line 2': 'Industrial Area',
    City: 'Vijayawada',
    District: 'Krishna',
    State: 'Andhra Pradesh',
    Country: 'India',
    'Postal Code': '520001',
    'Official Email': 'sample.org@example.com',
    'Contact Number': '+919876543210',
    Website: 'https://sample.example.com',
    'Authorized Signatory': 'Sample Director',
    'Financial Year Start': '2024-04-01',
    'Document Prefix': 'SMP',
    'Letterhead Name': 'Sample Organisation',
    'Default Footer Text': 'This is a sample footer for bulk upload testing.',
  };

  const headerToCol = new Map<string, number>();
  plan.fixedHeaders.forEach((h, i) => headerToCol.set(h.toLowerCase(), i + 1));
  plan.fieldColumns.forEach((c, i) => headerToCol.set(c.header.toLowerCase(), plan.fixedHeaders.length + i + 1));

  const rows: Array<{
    section: string;
    fieldType: string;
    fieldName: string;
    shortCode: string;
    parent: string;
    extra?: Record<string, string>;
  }> = [];

  if (!orgHasRoot(tree)) {
    rows.push({
      section: section1,
      fieldType: type1,
      fieldName: rootName,
      shortCode: 'SC1',
      parent: '',
      extra: detailValues,
    });
    rows.push({
      section: section2,
      fieldType: type2,
      fieldName: midName,
      shortCode: 'SAP',
      parent: rootName,
      extra: { City: 'Vijayawada', State: 'Andhra Pradesh', Status: 'Active' },
    });
    if (section3 && type3) {
      rows.push({
        section: section3,
        fieldType: type3,
        fieldName: leafName,
        shortCode: 'SOP',
        parent: midName,
        extra: { Status: 'Active', Description: 'Sample business unit for bulk testing' },
      });
    }
  } else if (existingRoot && section2) {
    // Org already has a root — only add optional child demo rows under the existing root Field Name.
    rows.push({
      section: section2,
      fieldType: type2,
      fieldName: midName,
      shortCode: 'SAP',
      parent: existingRoot.name,
      extra: { City: 'Vijayawada', State: 'Andhra Pradesh', Status: 'Active' },
    });
    if (section3 && type3) {
      rows.push({
        section: section3,
        fieldType: type3,
        fieldName: leafName,
        shortCode: 'SOP',
        parent: midName,
        extra: { Status: 'Active', Description: 'Sample business unit for bulk testing' },
      });
    }
  }

  if (rows.length === 0) {
    return pickExistingOrgUnitMapping(tree) || orgMappingDisplayLabel(section1, type1, rootName);
  }

  let startRow = firstEmptyDataRow(sheet, plan.columnIndex.fieldName);
  let lastRow = Math.max(1, startRow - 1);

  for (const row of rows) {
    const rowNum = startRow;
    startRow += 1;
    lastRow = rowNum;

    sheet.getCell(rowNum, plan.columnIndex.section).value = row.section;
    sheet.getCell(rowNum, plan.columnIndex.fieldType).value = row.fieldType;
    sheet.getCell(rowNum, plan.columnIndex.fieldName).value = row.fieldName;
    sheet.getCell(rowNum, plan.columnIndex.shortCode).value = row.shortCode;
    sheet.getCell(rowNum, plan.columnIndex.parentName).value = row.parent;
    setOrgStructureDisplayLabel(sheet, rowNum, plan.columnIndex.displayLabel, row.section, row.fieldType, row.fieldName);

    if (row.extra) {
      for (const [header, val] of Object.entries(row.extra)) {
        const col = headerToCol.get(header.toLowerCase());
        if (col != null && val) sheet.getCell(rowNum, col).value = val;
      }
    }
  }

  const totalCols = plan.fixedHeaders.length + plan.fieldColumns.length;
  updateOrgStructureTableRef(sheet, lastRow, totalCols);

  const mappingNode = existingRoot || { name: rootName, levelLabel: section1 };
  const mappingType = existingRoot ? getNodeEntityTypeFromMeta(existingRoot) : type1;
  return orgMappingDisplayLabel(mappingNode.levelLabel || section1, mappingType, mappingNode.name);
}

function fillServiceListSheet(workbook: ExcelJS.Workbook, complianceHeaders: string[]): void {
  const sheet = workbook.getWorksheet('Service List');
  if (!sheet) return;

  const headers = headerIndexMap(sheet);
  const rowNum = firstEmptyDataRow(sheet, headers.get('recurring task title/service list') ?? 1);

  const recurringTitle = complianceHeaders[0] || 'GST Filing';
  setByHeaders(sheet, rowNum, headers, {
    'RECURRING TASK TITLE/SERVICE LIST': recurringTitle,
    FREQUENCY: 'Monthly',
    'TASK ROLL OUT': 'End of Period',
    'ONE TIME TASK LIST': 'Sample One-Time Filing',
  });
}

function fillClientListSheet(
  workbook: ExcelJS.Workbook,
  orgUnitMapping: string,
  complianceHeaders: string[],
  reportingPartnerMobile: string
): void {
  const sheet = workbook.getWorksheet('Client List');
  if (!sheet) return;

  clearSampleDataRows(sheet, (_r, text) => text.includes('SAMPLE Client Pvt Ltd'));

  const headers = headerIndexMap(sheet);
  const rowNum = firstEmptyDataRow(sheet, headers.get('name of the client') ?? 1);

  const values: Record<string, string> = {
    'NAME OF THE CLIENT': 'SAMPLE Client Pvt Ltd',
    'ENTITY TYPE': 'Company',
    STATUS: 'Active',
    'ORG UNIT MAPPING': orgUnitMapping,
    PAN: 'ABCDE1234F',
    'REPORTING PARTNER': reportingPartnerMobile,
  };

  for (const title of complianceHeaders) {
    values[title] = 'Monthly';
  }

  setByHeaders(sheet, rowNum, headers, values);
}

function fillEmployeesSheet(
  workbook: ExcelJS.Workbook,
  orgUnitMapping: string,
  reportingPartnerMobile: string,
  sampleEmployeeMobile: string
): void {
  const sheet = workbook.getWorksheet('Employees');
  if (!sheet) return;

  clearSampleDataRows(
    sheet,
    (_r, text) => text.includes('Sample Test Employee') || text.includes('SAMPLE_EMP001')
  );

  const headers = headerIndexMap(sheet);
  const rowNum = firstEmptyDataRow(sheet, headers.get('name of the employee') ?? headers.get('mobile number') ?? 1);

  setByHeaders(sheet, rowNum, headers, {
    'EMPLOYEE ID': 'SAMPLE_EMP001',
    'NAME OF THE EMPLOYEE': 'Sample Test Employee',
    'MOBILE NUMBER': sampleEmployeeMobile,
    'EMAIL ID': 'sample.employee@example.com',
    DOB: '1995-06-15',
    GENDER: 'Male',
    ADDRESS: '123 Sample Street, Vijayawada, Andhra Pradesh 520001',
    'PAN NUMBER': 'PQRSX1234Z',
    'DATE OF JOINING': '2024-04-01',
    'EMPLOYMENT TYPE': 'Permanent',
    'EMPLOYEE STATUS': 'Active',
    DESIGNATION: 'Associate Consultant',
    'REPORTING TO': reportingPartnerMobile,
    'WORK LOCATION': orgUnitMapping,
    'ORG UNIT MAPPING': orgUnitMapping,
  });
}

function fillTasksSheet(
  workbook: ExcelJS.Workbook,
  sampleEmployeeMobile: string,
  reportingPartnerMobile: string
): void {
  const sheet = workbook.getWorksheet('Tasks');
  if (!sheet) return;

  clearSampleDataRows(sheet, (_r, text) => text.includes('SAMPLE GST Filing'));

  const headers = headerIndexMap(sheet);
  const rowNum = firstEmptyDataRow(sheet, headers.get('task title') ?? 1);

  setByHeaders(sheet, rowNum, headers, {
    'Task Title': 'SAMPLE GST Filing — June 2026',
    'Client Name': 'SAMPLE Client Pvt Ltd',
    'Assigned To': sampleEmployeeMobile,
    'Reporting Member': reportingPartnerMobile,
    'Start Date': '2026-06-01',
    'Target Date': '2026-06-05',
    'Due Date': '2026-06-10',
    'Task Type': 'one_time',
    Recurrence: 'Monthly',
    'Task Owner': reportingPartnerMobile,
    'Financial Value': '5000',
    Description: 'Sample task row for master bulk upload verification.',
    'Auto Escalate': 'No',
    Tags: 'sample,bulk-test',
    'Task Roll Out': 'cycle_start',
    'Recurrence End Type': 'never',
    'Recurrence End Date': '',
    'Recurrence After Occurrences': '',
    'Escalation Trigger': 'due_date',
    'Escalation Days Before': '2',
    'Escalation Contacts': '',
    'Compliance ID': '',
    'Document Instance ID': '',
  });
}

/**
 * Populate a workbook built by buildTemplateWorkbook with sample data on every data sheet.
 * Preserves hidden sheets, validations, formulas, and dynamic columns from the real template.
 */
export function fillMasterBulkSampleData(workbook: ExcelJS.Workbook, ctx: MasterBulkSampleContext): string {
  const reportingPartnerMobile = ctx.reportingPartnerMobile || '+919876543210';
  const sampleEmployeeMobile = ctx.sampleEmployeeMobile || '+919812349999';
  const newStructureMapping = fillOrganisationStructureSheet(workbook, ctx.tree);
  const orgUnitMapping = pickExistingOrgUnitMapping(ctx.tree) ?? newStructureMapping;
  fillServiceListSheet(workbook, ctx.complianceHeaders);
  fillClientListSheet(workbook, orgUnitMapping, ctx.complianceHeaders, reportingPartnerMobile);
  fillEmployeesSheet(workbook, orgUnitMapping, reportingPartnerMobile, sampleEmployeeMobile);
  fillTasksSheet(workbook, sampleEmployeeMobile, reportingPartnerMobile);
  return orgUnitMapping;
}

/** Build the exact Settings bulk download workbook with all sample rows filled. */
export async function buildSampleFilledMasterBulkWorkbook(organizationId: string): Promise<ExcelJS.Buffer> {
  const tree = await loadTreeForBulk(organizationId);
  const complianceHeaders = await getRecurringTaskServiceTitles(organizationId);
  const phones = await loadSamplePhones(organizationId);
  const templateBuffer = await buildTemplateWorkbook(organizationId);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer);
  fillMasterBulkSampleData(workbook, {
    organizationId,
    complianceHeaders,
    tree,
    reportingPartnerMobile: phones.reportingPartnerMobile,
    sampleEmployeeMobile: phones.sampleEmployeeMobile,
  });

  return (await workbook.xlsx.writeBuffer()) as ExcelJS.Buffer;
}
