import { query } from '../config/database';

export interface OrganizationData {
  name: string;
  shortName?: string;
  logoUrl?: string;
  address?: string;
  country?: string;
  state?: string;
  city?: string;
  pinCode?: string;
  addressLine1?: string;
  addressLine2?: string;
  email?: string;
  mobile?: string;
  website?: string;
  phoneNumber?: string;
  gst?: string;
  pan?: string;
  cin?: string;
  orgConstitution?: string;
  accountingYearStart?: string;
}

/**
 * Get organization data for Entity Master auto-fill (with new Entity Master fields)
 * @param organizationId - Organization ID
 * @returns Organization data with all Entity Master fields
 */
export async function getOrganizationData(organizationId: string): Promise<OrganizationData> {
  const result = await query(
    `SELECT 
      o.name, o.short_name, o.logo_url, o.address,
      o.country_id, o.state_id, o.city_id,
      o.pin_code, o.address_line1, o.address_line2,
      o.email, o.mobile, o.website, o.phone_number,
      o.gst, o.pan, o.cin, o.org_constitution,
      o.accounting_year_start,
      c.name as country_name,
      s.name as state_name,
      ci.name as city_name
    FROM organizations o
    LEFT JOIN countries c ON o.country_id = c.id
    LEFT JOIN states s ON o.state_id = s.id
    LEFT JOIN cities ci ON o.city_id = ci.id
    WHERE o.id = $1`,
    [organizationId]
  );

  if (result.rows.length === 0) {
    throw new Error('Organization not found');
  }

  const row = result.rows[0];

  return {
    name: row.name || '',
    shortName: row.short_name || undefined,
    logoUrl: row.logo_url || undefined,
    address: row.address || undefined,
    country: row.country_name || undefined,
    state: row.state_name || undefined,
    city: row.city_name || undefined,
    pinCode: row.pin_code || undefined,
    addressLine1: row.address_line1 || undefined,
    addressLine2: row.address_line2 || undefined,
    email: row.email || undefined,
    mobile: row.mobile || undefined,
    website: row.website || undefined,
    phoneNumber: row.phone_number || undefined,
    gst: row.gst || undefined,
    pan: row.pan || undefined,
    cin: row.cin || undefined,
    orgConstitution: row.org_constitution || undefined,
    accountingYearStart: row.accounting_year_start
      ? (typeof row.accounting_year_start === 'string' ? row.accounting_year_start : new Date(row.accounting_year_start).toISOString().split('T')[0])
      : undefined,
  };
}

/**
 * Format organization data for template replacement
 * Returns data in format suitable for template placeholders like {{org.name}}, {{org.gst}}, {{org.shortName}}, {{org.country}}, etc.
 */
export function formatOrganizationDataForTemplate(orgData: OrganizationData): Record<string, any> {
  return {
    org: {
      name: orgData.name,
      shortName: orgData.shortName || '',
      logoUrl: orgData.logoUrl || '',
      address: orgData.address || '',
      country: orgData.country || '',
      state: orgData.state || '',
      city: orgData.city || '',
      pinCode: orgData.pinCode || '',
      addressLine1: orgData.addressLine1 || '',
      addressLine2: orgData.addressLine2 || '',
      email: orgData.email || '',
      mobile: orgData.mobile || '',
      website: orgData.website || '',
      phoneNumber: orgData.phoneNumber || '',
      gst: orgData.gst || '',
      pan: orgData.pan || '',
      cin: orgData.cin || '',
      orgConstitution: orgData.orgConstitution || '',
      accountingYearStart: orgData.accountingYearStart || '',
    },
  };
}

