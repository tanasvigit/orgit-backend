import ExcelJS from 'exceljs';
import {
  getFieldSchemaForLevel,
  type OrganizationStructureFieldSchemaField,
  type OrganizationStructureLevel,
  type OrganizationStructureNode,
  type OrganizationStructureTree,
} from './organizationStructureService';
import {
  buildSectionLabelList,
  getEntityTypeOptionsForSection,
  LEVEL_ENTITY_TYPE_OPTIONS,
  ORG_LEVEL_DEFINITIONS,
} from './organizationStructureCatalog';
import { getActiveLevelsFromL2 } from './orgStructureBulkUtils';

export { LEVEL_ENTITY_TYPE_OPTIONS, ORG_LEVEL_DEFINITIONS };

export const INSTRUCTIONS_SHEET_NAME = 'Instructions';
export const ORG_STRUCTURE_DATA_SHEET_NAME = 'Organisation Structure';
// Deprecated: workbook now derives dropdowns directly from Organisation Structure.
export const LOOKUPS_SHEET_NAME = 'Org Node Lookups';
export const ORG_STRUCTURE_TABLE_NAME = 'OrgStructureNodes';

/** Fixed columns on Organisation Structure sheet (order matters). */
export const STRUCTURE_FIXED_HEADERS = [
  'Section',
  'Field Type',
  'Field Name',
  'Short Code',
  'Parent Name',
  'Display Label',
] as const;

export type StructureFieldColumn = {
  header: string;
  fieldKey: string;
  field: OrganizationStructureFieldSchemaField;
};

export type StructureSheetPlan = {
  fixedHeaders: string[];
  fieldColumns: StructureFieldColumn[];
  headerToFieldKey: Map<string, string>;
  /** 1-based column index for fixed fields */
  columnIndex: {
    section: number;
    fieldType: number;
    fieldName: number;
    shortCode: number;
    parentName: number;
    displayLabel: number;
  };
};

/**
 * Extra node-detail fields shown in web Edit Node modal.
 * Included in Organisation Structure bulk sheet so users can manage them in one place.
 */
const ORG_NODE_DETAIL_FIELD_CATALOG: OrganizationStructureFieldSchemaField[] = [
  { id: 'short_name', key: 'short_name', label: 'Short Name', type: 'text', required: false },
  { id: 'display_name', key: 'display_name', label: 'Display Name', type: 'text', required: false },
  { id: 'description', key: 'description', label: 'Description', type: 'textarea', required: false },
  {
    id: 'status',
    key: 'status',
    label: 'Status',
    type: 'select',
    required: false,
    options: ['Active', 'Inactive', 'Closed'],
  },
  { id: 'effective_from', key: 'effective_from', label: 'Effective From', type: 'date', required: false },
  { id: 'effective_to', key: 'effective_to', label: 'Effective To', type: 'date', required: false },
  {
    id: 'legal_constitution',
    key: 'legal_constitution',
    label: 'Entity Type / Legal Constitution',
    type: 'select',
    required: false,
    options: ['Company', 'LLP', 'Partnership', 'Trust', 'Society', 'Proprietorship', 'Other'],
  },
  { id: 'registration_number', key: 'registration_number', label: 'Registration Number', type: 'text', required: false },
  { id: 'cin', key: 'cin', label: 'CIN', type: 'text', required: false },
  { id: 'llpin', key: 'llpin', label: 'LLPIN', type: 'text', required: false },
  { id: 'pan', key: 'pan', label: 'PAN', type: 'text', required: false },
  { id: 'tan', key: 'tan', label: 'TAN', type: 'text', required: false },
  { id: 'gstin', key: 'gstin', label: 'GSTIN', type: 'text', required: false },
  { id: 'import_export_code', key: 'import_export_code', label: 'Import Export Code', type: 'text', required: false },
  {
    id: 'registered_address_line_1',
    key: 'registered_address_line_1',
    label: 'Registered Address Line 1',
    type: 'text',
    required: false,
  },
  {
    id: 'registered_address_line_2',
    key: 'registered_address_line_2',
    label: 'Registered Address Line 2',
    type: 'text',
    required: false,
  },
  { id: 'city', key: 'city', label: 'City', type: 'text', required: false },
  { id: 'district', key: 'district', label: 'District', type: 'text', required: false },
  { id: 'state', key: 'state', label: 'State', type: 'text', required: false },
  { id: 'country', key: 'country', label: 'Country', type: 'text', required: false },
  { id: 'postal_code', key: 'postal_code', label: 'Postal Code', type: 'pincode', required: false },
  { id: 'official_email', key: 'official_email', label: 'Official Email', type: 'text', required: false },
  { id: 'contact_number', key: 'contact_number', label: 'Contact Number', type: 'text', required: false },
  { id: 'website', key: 'website', label: 'Website', type: 'text', required: false },
  { id: 'authorized_signatory', key: 'authorized_signatory', label: 'Authorized Signatory', type: 'text', required: false },
  { id: 'financial_year_start', key: 'financial_year_start', label: 'Financial Year Start', type: 'date', required: false },
  { id: 'document_prefix', key: 'document_prefix', label: 'Document Prefix', type: 'text', required: false },
  { id: 'letterhead_name', key: 'letterhead_name', label: 'Letterhead Name', type: 'text', required: false },
  { id: 'seal_stamp_image', key: 'seal_stamp_image', label: 'Seal/Stamp Image', type: 'text', required: false },
  { id: 'default_footer_text', key: 'default_footer_text', label: 'Default Footer Text', type: 'textarea', required: false },
];

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

export function getEntityTypeOptionsForLevel(levelNumber: number): string[] {
  return [...(LEVEL_ENTITY_TYPE_OPTIONS[levelNumber] || ['Custom'])];
}

export function getEntityTypeOptionsForLevelRecord(level: OrganizationStructureLevel): string[] {
  return getEntityTypeOptionsForSection(level.levelLabel);
}

/** Same label as web dropdowns (`formatOrgNodeOptionLabel`). */
export function formatNodeDisplayLabel(
  node: Pick<OrganizationStructureNode, 'name' | 'levelLabel'>,
  entityType?: string | null
): string {
  const section = (node.levelLabel || '').trim();
  const raw = entityType && String(entityType).trim() ? String(entityType).trim() : '';
  if (raw && section && raw.toLowerCase() !== section.toLowerCase()) {
    return `${node.name} (${raw})`;
  }
  return node.name;
}

export function getNodeEntityTypeFromMeta(node: OrganizationStructureNode): string {
  const raw =
    node.metaJson && typeof node.metaJson.entityType === 'string'
      ? String(node.metaJson.entityType).trim()
      : '';
  return raw || node.levelLabel || '';
}

export function buildStructureSheetPlan(
  tree: OrganizationStructureTree,
  levels: OrganizationStructureLevel[]
): StructureSheetPlan {
  const fixedHeaders = [...STRUCTURE_FIXED_HEADERS];
  const fieldColumns: StructureFieldColumn[] = [];
  const headerToFieldKey = new Map<string, string>();
  const usedHeaders = new Set<string>(fixedHeaders.map((h) => h.toLowerCase()));

  const activeLevels = levels.filter((l) => l.isActive !== false).sort((a, b) => a.levelNumber - b.levelNumber);

  for (const level of activeLevels) {
    const schema = getFieldSchemaForLevel(tree, level.levelNumber);
    for (const field of schema) {
      const key = field.key?.trim();
      if (!key || key === 'name' || key === 'code') continue;
      let header = field.label?.trim() || key;
      if (usedHeaders.has(header.toLowerCase())) {
        header = `${level.levelLabel} — ${header}`;
      }
      usedHeaders.add(header.toLowerCase());
      headerToFieldKey.set(header.toLowerCase(), key);
      if (!fieldColumns.some((c) => c.fieldKey === key && c.header === header)) {
        fieldColumns.push({ header, fieldKey: key, field });
      }
    }
  }

  // Add web Edit Node detail fields after level-schema fields.
  for (const field of ORG_NODE_DETAIL_FIELD_CATALOG) {
    const key = field.key?.trim();
    if (!key || key === 'name' || key === 'code') continue;
    let header = field.label?.trim() || key;
    if (usedHeaders.has(header.toLowerCase())) {
      header = `Node — ${header}`;
    }
    if (fieldColumns.some((c) => c.fieldKey === key)) continue;
    usedHeaders.add(header.toLowerCase());
    headerToFieldKey.set(header.toLowerCase(), key);
    fieldColumns.push({ header, fieldKey: key, field });
  }

  headerToFieldKey.set('field name', 'name');
  headerToFieldKey.set('name', 'name');
  headerToFieldKey.set('short code', 'code');
  headerToFieldKey.set('code', 'code');

  return {
    fixedHeaders,
    fieldColumns,
    headerToFieldKey,
    columnIndex: {
      section: 1,
      fieldType: 2,
      fieldName: 3,
      shortCode: 4,
      parentName: 5,
      displayLabel: 6,
    },
  };
}

export function addInstructionsSheet(workbook: ExcelJS.Workbook, tree: OrganizationStructureTree): void {
  const sheet = workbook.addWorksheet(INSTRUCTIONS_SHEET_NAME, {
    headerFooter: { firstHeader: 'OrgIt master bulk upload' },
  });
  sheet.getColumn(1).width = 100;
  const levelsFromL2 = getActiveLevelsFromL2(tree);
  const lines = [
    'OrgIt Master Bulk workbook — fill in this order:',
    '  1. Organisation Structure  2. Service List  3. Client List  4. Employees  5. Tasks',
    '',
    'Organisation Structure (one row per org unit):',
    '  Section | Field Type | Field Name | Short Code | Parent Name | Display Label (auto)',
    '  Parent rows must appear before children. Leave Parent Name blank only for the root row.',
    '',
    'After adding Structure rows, press F9 or save the file — Client/Employee org dropdowns refresh from the Organisation Structure table.',
    'In Client List and Employees sheets, use "ORG UNIT MAPPING" dropdown to select org unit label.',
    '',
    `Sections in your org: ${levelsFromL2.map((l) => l.levelLabel).join(', ') || '(use Section = Group with blank Parent Name for first root)'}`,
    '',
    'Employee permissions (module access, task/document rights) are configured in the web UI only.',
    'Organisation legal profile (GST, registered address) is edited in Admin → Entity Master (web only).',
    'Legacy sheets (Cost Centres, Branches, Depot, Warehouse) are not supported.',
  ];
  lines.forEach((text, i) => {
    const row = sheet.getRow(i + 1);
    row.getCell(1).value = text;
    row.getCell(1).alignment = { wrapText: true };
  });
}

function sanitizeNamedRangePart(label: string): string {
  return label.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
}

/** Hidden sheet + named ranges for section-dependent Field Type dropdown (INDIRECT). */
export function addSectionEntityFieldReferenceSheet(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet('SectionEntityFields', { state: 'hidden' });
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 80;
  sheet.getColumn(3).width = 24;
  sheet.getCell(1, 1).value = 'Section';
  sheet.getCell(1, 2).value = 'Field Type Options';
  sheet.getCell(1, 3).value = 'NamedRange';
  sheet.getCell(1, 1).font = { bold: true };
  sheet.getCell(1, 2).font = { bold: true };
  sheet.getCell(1, 3).font = { bold: true };

  ORG_LEVEL_DEFINITIONS.forEach((def, idx) => {
    const row = idx + 2;
    const rangeName = `FT_${sanitizeNamedRangePart(def.headerCategory)}`;
    sheet.getCell(row, 1).value = def.headerCategory;
    sheet.getCell(row, 2).value = def.fieldValues.join(', ');
    sheet.getCell(row, 3).value = rangeName;

    const optCol = 4 + idx;
    const colLetter = getExcelColLetter(optCol);
    def.fieldValues.forEach((opt, optIdx) => {
      sheet.getCell(optIdx + 2, optCol).value = opt;
    });
    const lastRow = def.fieldValues.length + 1;
    if (lastRow >= 2) {
      workbook.definedNames.add(`SectionEntityFields!$${colLetter}$2:$${colLetter}$${lastRow}`, rangeName);
    }
  });
}

/** One column per org section; merges DB nodes + dynamic FILTER from OrgStructureNodes table. */
export function addOrgNodeLookupsSheet(workbook: ExcelJS.Workbook, tree: OrganizationStructureTree): void {
  const sheet = workbook.addWorksheet(LOOKUPS_SHEET_NAME, {
    headerFooter: { firstHeader: 'Dropdown values for Client List / Employees' },
  });
  const levelsFromL2 = getActiveLevelsFromL2(tree);
  if (levelsFromL2.length === 0) {
    sheet.getCell(1, 1).value = 'Add Organisation Structure rows first, or create org definition on web.';
    return;
  }

  levelsFromL2.forEach((level, colIdx) => {
    const col = colIdx + 1;
    const colLetter = getExcelColLetter(col);
    sheet.getColumn(col).width = 36;
    sheet.getCell(1, col).value = level.levelLabel;
    sheet.getCell(1, col).font = { bold: true };

    const nodes = (tree.nodes || [])
      .filter(
        (n) =>
          n.status === 'active' &&
          (n.levelLabel || '').trim().toLowerCase() === level.levelLabel.trim().toLowerCase() &&
          (tree.rootNode ? (n.pathIds || []).includes(tree.rootNode.id) : true)
      )
      .sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));

    nodes.forEach((node, rowIdx) => {
      sheet.getCell(rowIdx + 2, col).value = formatNodeDisplayLabel(node, getNodeEntityTypeFromMeta(node));
    });

    const sectionHeaderRef = `${colLetter}$1`;
    const filterFormula = `IFERROR(UNIQUE(FILTER(${ORG_STRUCTURE_TABLE_NAME}[Display Label],(${ORG_STRUCTURE_TABLE_NAME}[Section]=${sectionHeaderRef})*(${ORG_STRUCTURE_TABLE_NAME}[Display Label]<>""))),"")`;
    const spillStartRow = Math.max(2, nodes.length + 2);
    sheet.getCell(spillStartRow, col).value = { formula: filterFormula, result: '' };
  });
}

export function getLookupColumnLetterForLevel(
  levelsFromL2: OrganizationStructureLevel[],
  level: OrganizationStructureLevel
): string {
  const idx = levelsFromL2.findIndex((l) => l.id === level.id);
  return getExcelColLetter(idx >= 0 ? idx + 1 : 1);
}

/** Dynamic validation range — covers DB-seeded rows and FILTER spill from structure table. */
export function getLookupValidationRange(levelsFromL2: OrganizationStructureLevel[], level: OrganizationStructureLevel): string {
  const idx = levelsFromL2.findIndex((l) => l.id === level.id);
  const helperCol = 200 + (idx >= 0 ? idx : 0); // hidden helper columns on Organisation Structure
  const colLetter = getExcelColLetter(helperCol);
  return `'${ORG_STRUCTURE_DATA_SHEET_NAME}'!$${colLetter}$2:$${colLetter}$5000`;
}

/** Organisation Structure data sheet with validations and Excel table. */
export function addOrganisationStructureDataSheet(
  workbook: ExcelJS.Workbook,
  tree: OrganizationStructureTree,
  levels: OrganizationStructureLevel[]
): StructureSheetPlan {
  const plan = buildStructureSheetPlan(tree, levels);
  const sheet = workbook.addWorksheet(ORG_STRUCTURE_DATA_SHEET_NAME, {
    headerFooter: { firstHeader: 'OrgIt Master Bulk - Organisation Structure' },
  });

  const allHeaders = [...plan.fixedHeaders, ...plan.fieldColumns.map((c) => c.header)];
  allHeaders.forEach((h, i) => {
    const col = sheet.getColumn(i + 1);
    col.width = Math.min(36, Math.max(14, h.length + 2));
    sheet.getCell(1, i + 1).value = h;
    sheet.getCell(1, i + 1).font = { bold: true };
  });

  const sectionLabels = buildSectionLabelList(
    levels.filter((l) => l.isActive !== false).map((l) => l.levelLabel)
  ).join(',');
  if (sectionLabels) {
    (sheet as any).dataValidations.add('A2:A5000', {
      type: 'list',
      allowBlank: false,
      formulae: [`"${sectionLabels}"`],
      showErrorMessage: true,
      errorTitle: 'Section',
      error: 'Select a section (same list as web Org Definition).',
    });
  }

  (sheet as any).dataValidations.add('B2:B5000', {
    type: 'list',
    allowBlank: true,
    formulae: ['=INDIRECT(VLOOKUP(A2,SectionEntityFields!$A$2:$C$20,3,FALSE))'],
    showErrorMessage: true,
    errorTitle: 'Field Type',
    error: 'Field Type must match the selected Section.',
  });

  (sheet as any).dataValidations.add('E2:E5000', {
    type: 'list',
    allowBlank: true,
    // Stable parent source from Organisation Structure Field Name column.
    // Keeps dropdown reliable across Excel versions.
    formulae: [`='${ORG_STRUCTURE_DATA_SHEET_NAME}'!$C$2:$C$5000`],
    showErrorMessage: true,
    errorTitle: 'Parent Name',
    error: 'Select parent from Field Name values, or leave blank for root only.',
  });

  plan.fieldColumns.forEach((colDef, i) => {
    const colIndex = plan.fixedHeaders.length + i + 1;
    if (colDef.field.type === 'select' && colDef.field.options?.length) {
      const letter = getExcelColLetter(colIndex);
      const opts = colDef.field.options.join(',');
      (sheet as any).dataValidations.add(`${letter}2:${letter}5000`, {
        type: 'list',
        allowBlank: !colDef.field.required,
        formulae: [`"${opts}"`],
        showErrorMessage: true,
        errorTitle: colDef.header,
        error: `Select from list (${colDef.header}).`,
      });
    }
  });

  // Ensure Display Label formula exists for entry rows so Client/Employee ORG UNIT MAPPING dropdown updates
  // immediately as users type rows in Organisation Structure.
  for (let rowNum = 2; rowNum <= 5000; rowNum += 1) {
    const cell = sheet.getCell(rowNum, plan.columnIndex.displayLabel);
    if (!cell.value) {
      const displayFormula = `IF(C${rowNum}="","",IF(LOWER(B${rowNum})=LOWER(A${rowNum}),C${rowNum},C${rowNum}&" ("&B${rowNum}&")"))`;
      cell.value = { formula: displayFormula, result: '' };
    }
  }

  const sorted = [...(tree.nodes || [])].sort(
    (a, b) => a.levelNumber - b.levelNumber || a.displayOrder - b.displayOrder || a.name.localeCompare(b.name)
  );

  let lastDataRow = 1;
  sorted.forEach((node, rowIdx) => {
    const rowNum = rowIdx + 2;
    lastDataRow = rowNum;
    sheet.getCell(rowNum, plan.columnIndex.section).value = node.levelLabel || String(node.levelNumber);
    sheet.getCell(rowNum, plan.columnIndex.fieldType).value = getNodeEntityTypeFromMeta(node);
    sheet.getCell(rowNum, plan.columnIndex.fieldName).value = node.name;
    if (node.code) {
      sheet.getCell(rowNum, plan.columnIndex.shortCode).value = node.code;
    }
    sheet.getCell(rowNum, plan.columnIndex.parentName).value = node.parentName || '';
    const displayFormula = `IF(C${rowNum}="","",IF(LOWER(B${rowNum})=LOWER(A${rowNum}),C${rowNum},C${rowNum}&" ("&B${rowNum}&")"))`;
    sheet.getCell(rowNum, plan.columnIndex.displayLabel).value = {
      formula: displayFormula,
      result: formatNodeDisplayLabel(node, getNodeEntityTypeFromMeta(node)),
    };

    const fv = node.fieldValues || {};
    plan.fieldColumns.forEach((colDef, i) => {
      const val =
        fv[colDef.fieldKey] ??
        (colDef.fieldKey === 'description' ? node.description ?? '' : null) ??
        (colDef.fieldKey === 'status' ? node.status ?? '' : null);
      if (val !== undefined && val !== null && String(val) !== '') {
        sheet.getCell(rowNum, plan.fixedHeaders.length + i + 1).value = String(val);
      }
    });
  });

  const tableEndCol = getExcelColLetter(allHeaders.length);
  const tableEndRow = Math.max(2, lastDataRow);
  try {
    sheet.addTable({
      name: ORG_STRUCTURE_TABLE_NAME,
      ref: `A1:${tableEndCol}${tableEndRow}`,
      headerRow: true,
      columns: allHeaders.map((name) => ({ name, filterButton: false })),
      rows: [],
    });
  } catch (err) {
    console.warn('[OrgStructureTemplate] Could not add Excel table:', err);
  }

  // Hidden helper columns for direct dropdowns from Organisation Structure (no separate lookup sheet).
  const levelsFromL2 = getActiveLevelsFromL2(tree);
  levelsFromL2.forEach((level, idx) => {
    const helperCol = 200 + idx;
    const helperLetter = getExcelColLetter(helperCol);
    sheet.getColumn(helperCol).hidden = true;
    sheet.getCell(1, helperCol).value = level.levelLabel;
    const formula = `IFERROR(UNIQUE(FILTER(${ORG_STRUCTURE_TABLE_NAME}[Display Label],(${ORG_STRUCTURE_TABLE_NAME}[Section]=${helperLetter}$1)*(${ORG_STRUCTURE_TABLE_NAME}[Display Label]<>""))),"")`;
    sheet.getCell(2, helperCol).value = { formula, result: '' };
  });

  return plan;
}

/** Apply dropdown on Entity List / Employees section columns. */
export function applyOrgAssignmentDropdowns(
  sheet: ExcelJS.Worksheet,
  _tree: OrganizationStructureTree,
  levelColumnStart1Based: number,
  _levelsFromL2: OrganizationStructureLevel[]
): void {
  const colLetter = getExcelColLetter(levelColumnStart1Based);
  (sheet as any).dataValidations.add(`${colLetter}2:${colLetter}1000`, {
    type: 'list',
    allowBlank: true,
    formulae: [`='${ORG_STRUCTURE_DATA_SHEET_NAME}'!$F$2:$F$5000`],
    showErrorMessage: true,
    errorTitle: 'ORG UNIT MAPPING',
    error: 'Select org unit from Organisation Structure labels.',
  });
}

export function applyBulkTemplateEnhancements(
  workbook: ExcelJS.Workbook,
  tree: OrganizationStructureTree,
  options?: {
    entityListLevelStartCol?: number;
    employeesLevelStartCol?: number;
  }
): void {
  const levelsFromL2 = getActiveLevelsFromL2(tree);
  if (options?.entityListLevelStartCol) {
    const entitySheet = workbook.getWorksheet('Client List') || workbook.getWorksheet('Entity List');
    if (entitySheet) {
      applyOrgAssignmentDropdowns(entitySheet, tree, options.entityListLevelStartCol, levelsFromL2);
    }
  }
  if (options?.employeesLevelStartCol) {
    const sheet = workbook.getWorksheet('Employees');
    if (sheet) {
      applyOrgAssignmentDropdowns(sheet, tree, options.employeesLevelStartCol, levelsFromL2);
    }
  }
}
