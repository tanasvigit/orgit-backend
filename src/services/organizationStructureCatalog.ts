/** Catalog sections and entity-field options — aligned with web `organizationStructureEntityTypes.ts`. */

export const LEVEL_ENTITY_TYPE_OPTIONS: Record<number, readonly string[]> = {
  1: ['Group', 'Enterprise', 'Corporate Group', 'Global Group', 'Business Group', 'Conglomerate', 'Custom'],
  2: [
    'Holding Company', 'Company', 'Subsidiary', 'Associate Company', 'Joint Venture', 'LLP',
    'Partnership Firm', 'Proprietorship', 'Trust', 'Society', 'Foundation', 'NGO', 'Foreign Entity',
    'Branch Entity', 'SPV', 'Section 8 Company', 'Custom',
  ],
  3: ['Region', 'Country', 'State', 'Zone', 'Territory', 'Cluster', 'Area', 'Circle', 'District', 'Market', 'Geography', 'Custom'],
  4: [
    'Business Unit', 'Strategic Business Unit (SBU)', 'Division', 'Vertical', 'Service Line', 'Product Line',
    'Shared Services', 'Functional Unit', 'Custom',
  ],
  5: [
    'Registered Office', 'Corporate Office', 'Head Office', 'Branch', 'Warehouse', 'Depot',
    'Delivery Center', 'Retail Store', 'Service Center', 'Project Site', 'Plant', 'Factory', 'Yard',
    'Facility', 'Delivery Hub', 'Custom',
  ],
  6: ['Department', 'Section', 'Team', 'Custom'],
  7: ['Project', 'Program', 'Custom'],
  8: ['Production Unit', 'Manufacturing Unit', 'Custom'],
  9: ['Distribution Centre', 'Logistics Hub', 'Storage Facility', 'Custom'],
  10: ['Cost Centre', 'Profit Centre', 'Budget Unit', 'Expense Unit', 'Revenue Unit', 'Custom'],
  11: ['Custom Unit', 'Custom'],
};

export type OrgLevelDefinition = {
  levelNumber: number;
  headerCategory: string;
  fieldValues: readonly string[];
};

export const ORG_LEVEL_DEFINITIONS: readonly OrgLevelDefinition[] = [
  { levelNumber: 1, headerCategory: 'Group', fieldValues: LEVEL_ENTITY_TYPE_OPTIONS[1] },
  { levelNumber: 2, headerCategory: 'Entity', fieldValues: LEVEL_ENTITY_TYPE_OPTIONS[2] },
  { levelNumber: 3, headerCategory: 'Region', fieldValues: LEVEL_ENTITY_TYPE_OPTIONS[3] },
  { levelNumber: 4, headerCategory: 'Business Unit', fieldValues: LEVEL_ENTITY_TYPE_OPTIONS[4] },
  { levelNumber: 5, headerCategory: 'Location', fieldValues: LEVEL_ENTITY_TYPE_OPTIONS[5] },
  { levelNumber: 6, headerCategory: 'Department', fieldValues: LEVEL_ENTITY_TYPE_OPTIONS[6] },
  { levelNumber: 7, headerCategory: 'Project', fieldValues: LEVEL_ENTITY_TYPE_OPTIONS[7] },
  { levelNumber: 8, headerCategory: 'Manufacturing Unit', fieldValues: LEVEL_ENTITY_TYPE_OPTIONS[8] },
  { levelNumber: 9, headerCategory: 'Warehouse / Distribution', fieldValues: LEVEL_ENTITY_TYPE_OPTIONS[9] },
  { levelNumber: 10, headerCategory: 'Financial Unit', fieldValues: LEVEL_ENTITY_TYPE_OPTIONS[10] },
  { levelNumber: 11, headerCategory: 'Custom Unit', fieldValues: LEVEL_ENTITY_TYPE_OPTIONS[11] },
];

export function getOrgLevelDefinitionByHeader(headerCategory?: string): OrgLevelDefinition | undefined {
  const normalized = String(headerCategory || '').trim().toLowerCase();
  if (!normalized) return undefined;
  return ORG_LEVEL_DEFINITIONS.find((def) => def.headerCategory.toLowerCase() === normalized);
}

export function getEntityTypeOptionsForSection(sectionLabel: string): string[] {
  const def = getOrgLevelDefinitionByHeader(sectionLabel);
  if (def) return [...def.fieldValues];
  const match = ORG_LEVEL_DEFINITIONS.find(
    (d) => d.headerCategory.toLowerCase() === sectionLabel.trim().toLowerCase()
  );
  if (match) return [...match.fieldValues];
  return ['Custom'];
}

/** All section names for template dropdowns (catalog + custom labels from DB). */
export function buildSectionLabelList(existingLevelLabels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const def of ORG_LEVEL_DEFINITIONS) {
    const label = def.headerCategory.trim();
    const key = label.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(label);
    }
  }
  for (const label of existingLevelLabels) {
    const trimmed = label.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

export const BULK_CREATE_LEVEL_FIELD_SCHEMA = [
  { id: 'name', key: 'name', label: 'Name', type: 'text' as const, required: true },
  { id: 'code', key: 'code', label: 'Code', type: 'text' as const, required: false },
];
