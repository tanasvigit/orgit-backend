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
export const LOOKUPS_SHEET_NAME = 'Org Node Lookups';

export type StructureFieldColumn = {
  header: string;
  fieldKey: string;
  field: OrganizationStructureFieldSchemaField;
};

export type StructureSheetPlan = {
  fixedHeaders: string[];
  fieldColumns: StructureFieldColumn[];
  headerToFieldKey: Map<string, string>;
};

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
  const raw =
    entityType && String(entityType).trim()
      ? String(entityType).trim()
      : '';
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
  const fixedHeaders = ['SECTION', 'PARENT_NAME', 'ENTITY_TYPE'];
  const fieldColumns: StructureFieldColumn[] = [];
  const headerToFieldKey = new Map<string, string>();
  const usedHeaders = new Set<string>();

  const activeLevels = levels.filter((l) => l.isActive !== false).sort((a, b) => a.levelNumber - b.levelNumber);

  for (const level of activeLevels) {
    const schema = getFieldSchemaForLevel(tree, level.levelNumber);
    for (const field of schema) {
      const key = field.key?.trim();
      if (!key || (key === 'name' && fieldColumns.some((c) => c.fieldKey === 'name'))) {
        continue;
      }
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

  if (!fieldColumns.some((c) => c.fieldKey === 'name')) {
    const header = 'Name';
    fieldColumns.unshift({
      header,
      fieldKey: 'name',
      field: { id: 'name', key: 'name', label: 'Name', type: 'text', required: true },
    });
    headerToFieldKey.set(header.toLowerCase(), 'name');
  }

  return { fixedHeaders, fieldColumns, headerToFieldKey };
}

export function addInstructionsSheet(workbook: ExcelJS.Workbook, tree: OrganizationStructureTree): void {
  const sheet = workbook.addWorksheet(INSTRUCTIONS_SHEET_NAME, {
    headerFooter: { firstHeader: 'OrgIt bulk upload — how to fill (matches web UI)' },
  });
  sheet.getColumn(1).width = 100;
  const levelsFromL2 = getActiveLevelsFromL2(tree.levels);
  const lines = [
    'Organisation Structure bulk upload (same flow as web Org Definition):',
    '  SECTION → ENTITY_TYPE (entity field) → Name / Code → PARENT_NAME (blank for root only).',
    '  Stage/column is set automatically from the parent (do not add a Stage column).',
    '',
    '1. Organisation Structure — one row per node. Parent rows must appear before children (or already exist on web).',
    '2. Use Org Node Lookups for display labels when assigning clients/employees later.',
    '',
    'SECTION: pick from dropdown (Group, Entity, Department, …). New sections are created on upload.',
    'PARENT_NAME: exact node name or label from Org Node Lookups (e.g. "Acme Ltd (Company)"). Leave blank only for the single root row.',
    '',
    `Sections in your org: ${levelsFromL2.map((l) => l.levelLabel).join(', ') || '(add root on web first, or use SECTION = Group with blank parent)'}`,
    '',
    'Optional: import OrgItOrgStructureBulk.bas (VBA) from orgit-tools/org-structure-bulk-vba for guided entry in Excel.',
    'Legacy sheets (Cost Centres, Branches, Depot, Warehouse) are not supported.',
  ];
  lines.forEach((text, i) => {
    const row = sheet.getRow(i + 1);
    row.getCell(1).value = text;
    row.getCell(1).alignment = { wrapText: true };
  });
}

/** One column per org section; dropdown source for Entity List / Employees. */
export function addOrgNodeLookupsSheet(workbook: ExcelJS.Workbook, tree: OrganizationStructureTree): void {
  const sheet = workbook.addWorksheet(LOOKUPS_SHEET_NAME, {
    headerFooter: { firstHeader: 'Dropdown values — same options as web' },
  });
  const levelsFromL2 = getActiveLevelsFromL2(tree.levels);
  if (levelsFromL2.length === 0) {
    sheet.getCell(1, 1).value = 'No sections defined. Add Org Definition on web first.';
    return;
  }

  levelsFromL2.forEach((level, colIdx) => {
    const col = colIdx + 1;
    sheet.getColumn(col).width = 32;
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
  });
}

export function getLookupColumnLetterForLevel(levelsFromL2: OrganizationStructureLevel[], level: OrganizationStructureLevel): string {
  const idx = levelsFromL2.findIndex((l) => l.id === level.id);
  return getExcelColLetter(idx >= 0 ? idx + 1 : 1);
}

export function getLookupLastRowForLevel(tree: OrganizationStructureTree, level: OrganizationStructureLevel): number {
  const nodes = (tree.nodes || []).filter(
    (n) =>
      n.status === 'active' &&
      (n.levelLabel || '').trim().toLowerCase() === level.levelLabel.trim().toLowerCase()
  );
  return Math.max(2, nodes.length + 1);
}

/** Reference for Excel/VBA: entity-field options per SECTION (column A = section, B = comma-separated types). */
export function addSectionEntityFieldReferenceSheet(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet('SectionEntityFields', {
    state: 'hidden',
  });
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 80;
  sheet.getCell(1, 1).value = 'SECTION';
  sheet.getCell(1, 2).value = 'ENTITY_TYPE_OPTIONS';
  sheet.getCell(1, 1).font = { bold: true };
  sheet.getCell(1, 2).font = { bold: true };
  ORG_LEVEL_DEFINITIONS.forEach((def, idx) => {
    const row = idx + 2;
    sheet.getCell(row, 1).value = def.headerCategory;
    sheet.getCell(row, 2).value = def.fieldValues.join(', ');
  });
}

export function addOrganisationStructureDataSheet(
  workbook: ExcelJS.Workbook,
  tree: OrganizationStructureTree,
  levels: OrganizationStructureLevel[]
): StructureSheetPlan {
  const plan = buildStructureSheetPlan(tree, levels);
  const sheet = workbook.addWorksheet(ORG_STRUCTURE_DATA_SHEET_NAME, {
    headerFooter: { firstHeader: 'OrgIt Settings - Organisation Structure (web fields)' },
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
      errorTitle: 'SECTION',
      error: 'Select a section (same list as web Org Definition).',
    });
  }

  const entityTypeUnion = [...new Set(ORG_LEVEL_DEFINITIONS.flatMap((d) => [...d.fieldValues]))].join(',');
  if (entityTypeUnion) {
    (sheet as any).dataValidations.add('C2:C5000', {
      type: 'list',
      allowBlank: true,
      formulae: [`"${entityTypeUnion}"`],
      showErrorMessage: true,
      errorTitle: 'ENTITY_TYPE',
      error: 'Entity field / type (validated per SECTION on upload).',
    });
  }

  plan.fieldColumns.forEach((colDef, i) => {
    const colIndex = plan.fixedHeaders.length + i + 1;
    if (colDef.field.type === 'select' && colDef.field.options?.length) {
      const letter = getExcelColLetter(colIndex);
      const opts = colDef.field.options.join(',');
      (sheet as any).dataValidations.add(`${letter}2:${letter}1000`, {
        type: 'list',
        allowBlank: !colDef.field.required,
        formulae: [`"${opts}"`],
        showErrorMessage: true,
        errorTitle: colDef.header,
        error: `Select from list (${colDef.header}).`,
      });
    }
  });

  const sorted = [...(tree.nodes || [])].sort(
    (a, b) => a.levelNumber - b.levelNumber || a.displayOrder - b.displayOrder || a.name.localeCompare(b.name)
  );
  sorted.forEach((node, rowIdx) => {
    const rowNum = rowIdx + 2;
    sheet.getCell(rowNum, 1).value = node.levelLabel || String(node.levelNumber);
    sheet.getCell(rowNum, 2).value = node.parentName || '';
    sheet.getCell(rowNum, 3).value = getNodeEntityTypeFromMeta(node);
    const fv = node.fieldValues || {};
    plan.fieldColumns.forEach((colDef, i) => {
      const val = fv[colDef.fieldKey];
      if (val !== undefined && val !== null && String(val) !== '') {
        sheet.getCell(rowNum, plan.fixedHeaders.length + i + 1).value = String(val);
      } else if (colDef.fieldKey === 'name') {
        sheet.getCell(rowNum, plan.fixedHeaders.length + i + 1).value = node.name;
      } else if (colDef.fieldKey === 'code' && node.code) {
        sheet.getCell(rowNum, plan.fixedHeaders.length + i + 1).value = node.code;
      }
    });
  });

  return plan;
}

/** Apply dropdown on Entity List / Employees section columns (web: EmployeeOrgLevelNodeSelectors). */
export function applyOrgAssignmentDropdowns(
  sheet: ExcelJS.Worksheet,
  tree: OrganizationStructureTree,
  levelColumnStart1Based: number,
  levelsFromL2: OrganizationStructureLevel[]
): void {
  if (!(tree.summary?.hasRootNode || tree.summary?.hasRootGroup) || levelsFromL2.length === 0) return;

  levelsFromL2.forEach((level, idx) => {
    const colLetter = getExcelColLetter(levelColumnStart1Based + idx);
    const lookupCol = getLookupColumnLetterForLevel(levelsFromL2, level);
    const lastRow = getLookupLastRowForLevel(tree, level);
    if (lastRow < 2) return;
    (sheet as any).dataValidations.add(`${colLetter}2:${colLetter}1000`, {
      type: 'list',
      allowBlank: false,
      formulae: [`='${LOOKUPS_SHEET_NAME}'!$${lookupCol}$2:$${lookupCol}$${lastRow}`],
      showErrorMessage: true,
      errorTitle: level.levelLabel,
      error: `Select ${level.levelLabel} from the list (same as web).`,
    });
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
  const levelsFromL2 = getActiveLevelsFromL2(tree.levels);
  if (options?.entityListLevelStartCol) {
    const sheet = workbook.getWorksheet('Entity List');
    if (sheet) {
      applyOrgAssignmentDropdowns(sheet, tree, options.entityListLevelStartCol, levelsFromL2);
    }
  }
  if (options?.employeesLevelStartCol) {
    const sheet = workbook.getWorksheet('Employees');
    if (sheet) {
      applyOrgAssignmentDropdowns(sheet, tree, options.employeesLevelStartCol, levelsFromL2);
    }
  }
}
