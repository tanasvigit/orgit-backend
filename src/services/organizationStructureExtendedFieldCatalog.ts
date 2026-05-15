import type { OrganizationStructureFieldSchemaField } from './organizationStructureService';

type FieldDef = OrganizationStructureFieldSchemaField;

const cat = (_category: string, fields: FieldDef[]): FieldDef[] => fields;

export const ORG_STRUCTURE_EXTENDED_FIELD_CATALOG: FieldDef[] = [
  ...cat('General', [
    { id: 'name', key: 'name', label: 'Registered Name', type: 'text', required: true },
    { id: 'code', key: 'code', label: 'Org Unit Code', type: 'text', required: false },
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
  ]),
  ...cat('Legal', [
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
  ]),
  ...cat('Tax', [
    { id: 'pan', key: 'pan', label: 'PAN', type: 'text', required: false },
    { id: 'tan', key: 'tan', label: 'TAN', type: 'text', required: false },
    { id: 'gstin', key: 'gstin', label: 'GSTIN', type: 'text', required: false },
    { id: 'import_export_code', key: 'import_export_code', label: 'Import Export Code', type: 'text', required: false },
  ]),
  ...cat('Address', [
    { id: 'registered_address_line_1', key: 'registered_address_line_1', label: 'Registered Address Line 1', type: 'text', required: false },
    { id: 'registered_address_line_2', key: 'registered_address_line_2', label: 'Registered Address Line 2', type: 'text', required: false },
    { id: 'city', key: 'city', label: 'City', type: 'text', required: false },
    { id: 'district', key: 'district', label: 'District', type: 'text', required: false },
    { id: 'state', key: 'state', label: 'State', type: 'text', required: false },
    { id: 'country', key: 'country', label: 'Country', type: 'text', required: false },
    { id: 'postal_code', key: 'postal_code', label: 'Postal Code', type: 'pincode', required: false },
  ]),
  ...cat('Contact', [
    { id: 'official_email', key: 'official_email', label: 'Official Email', type: 'text', required: false },
    { id: 'contact_number', key: 'contact_number', label: 'Contact Number', type: 'text', required: false },
    { id: 'website', key: 'website', label: 'Website', type: 'text', required: false },
  ]),
  ...cat('Compliance', [
    { id: 'authorized_signatory', key: 'authorized_signatory', label: 'Authorized Signatory', type: 'text', required: false },
  ]),
  ...cat('Finance', [
    { id: 'financial_year_start', key: 'financial_year_start', label: 'Financial Year Start', type: 'date', required: false },
  ]),
  ...cat('Document', [
    { id: 'document_prefix', key: 'document_prefix', label: 'Document Prefix', type: 'text', required: false },
    { id: 'letterhead_name', key: 'letterhead_name', label: 'Letterhead Name', type: 'text', required: false },
    { id: 'seal_stamp_image', key: 'seal_stamp_image', label: 'Seal/Stamp Image', type: 'text', required: false },
    { id: 'default_footer_text', key: 'default_footer_text', label: 'Default Footer Text', type: 'textarea', required: false },
  ]),
];

export function mergeFieldSchemasByKey(...groups: FieldDef[][]): FieldDef[] {
  const map = new Map<string, FieldDef>();
  for (const group of groups) {
    for (const field of group) {
      if (field.key?.trim()) {
        map.set(field.key.trim(), field);
      }
    }
  }
  return Array.from(map.values());
}

export function getCustomFieldSchemaFromMeta(metaJson: Record<string, unknown> | undefined): FieldDef[] {
  if (!metaJson || !Array.isArray(metaJson.customFieldSchema)) {
    return [];
  }
  return (metaJson.customFieldSchema as FieldDef[]).filter((f) => f && typeof f.key === 'string' && f.key.trim());
}
