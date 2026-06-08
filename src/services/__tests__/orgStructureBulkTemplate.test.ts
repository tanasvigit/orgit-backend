import ExcelJS from 'exceljs';
import {
  STRUCTURE_FIXED_HEADERS,
  buildStructureSheetPlan,
  formatNodeDisplayLabel,
} from '../orgStructureBulkTemplate';
import type { OrganizationStructureTree } from '../organizationStructureService';

function emptyTree(): OrganizationStructureTree {
  return {
    levels: [],
    catalogLevels: [],
    nodes: [],
    stages: [],
    rootNode: null,
    summary: {
      hasRootNode: false,
      hasRootGroup: false,
      totalLevels: 0,
      totalNodes: 0,
      archivedNodes: 0,
      totalStages: 0,
      activeNodes: 0,
    },
  } as unknown as OrganizationStructureTree;
}

describe('buildStructureSheetPlan', () => {
  it('uses new fixed headers in order', () => {
    const plan = buildStructureSheetPlan(emptyTree(), []);
    expect(plan.fixedHeaders).toEqual([...STRUCTURE_FIXED_HEADERS]);
    expect(plan.columnIndex.fieldName).toBe(3);
    expect(plan.columnIndex.parentName).toBe(5);
  });

  it('maps Field Name and Short Code without duplicating dynamic columns', () => {
    const plan = buildStructureSheetPlan(emptyTree(), []);
    expect(plan.headerToFieldKey.get('field name')).toBe('name');
    expect(plan.headerToFieldKey.get('short code')).toBe('code');
    expect(plan.fieldColumns.some((c) => c.fieldKey === 'name')).toBe(false);
    expect(plan.fieldColumns.some((c) => c.fieldKey === 'code')).toBe(false);
  });
});

describe('formatNodeDisplayLabel', () => {
  it('appends field type when different from section', () => {
    expect(formatNodeDisplayLabel({ name: 'Acme Ltd', levelLabel: 'Entity' }, 'Company')).toBe(
      'Acme Ltd (Company)'
    );
  });

  it('returns plain name when type matches section', () => {
    expect(formatNodeDisplayLabel({ name: 'North', levelLabel: 'Region' }, 'Region')).toBe('North');
  });
});

describe('organisation structure header aliases', () => {
  it('accepts legacy SECTION / PARENT_NAME / ENTITY_TYPE with Name column', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Organisation Structure');
    sheet.addRow(['SECTION', 'PARENT_NAME', 'ENTITY_TYPE', 'Name', 'Code']);
    sheet.addRow(['Group', '', 'Group', 'Root Org', 'R1']);

    const headers = sheet.getRow(1).values as unknown[];
    const colIndex = (...names: string[]): number => {
      for (const name of names) {
        const i = (headers || []).findIndex(
          (h) => String(h ?? '').trim().toLowerCase() === name.toLowerCase()
        );
        if (i >= 0) return i;
      }
      return -1;
    };

    expect(colIndex('section', 'level')).toBeGreaterThan(0);
    expect(colIndex('parent name', 'parent_name')).toBeGreaterThan(0);
    expect(colIndex('field type', 'entity_type', 'entity type')).toBeGreaterThan(0);
    expect(colIndex('field name', 'name')).toBeGreaterThan(0);
  });

  it('accepts new Section / Field Type / Field Name / Short Code / Parent Name headers', () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Organisation Structure');
    sheet.addRow([...STRUCTURE_FIXED_HEADERS]);
    const headers = sheet.getRow(1).values as unknown[];
    const normalized = headers.filter(Boolean).map((h) => String(h).trim());
    expect(normalized).toContain('Section');
    expect(normalized).toContain('Field Type');
    expect(normalized).toContain('Field Name');
    expect(normalized).toContain('Short Code');
    expect(normalized).toContain('Parent Name');
  });
});
