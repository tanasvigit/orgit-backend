import { query } from '../config/database';
import pool from '../config/database';

export interface CostCentre {
  id: string;
  name: string;
  shortName?: string;
  displayOrder?: number;
}

export interface Branch {
  id: string;
  name: string;
  shortName?: string;
  address?: string;
  gstNumber?: string;
}

export interface Depot {
  id: string;
  name: string;
  shortName?: string;
  displayOrder?: number;
}

export interface Warehouse {
  id: string;
  name: string;
  shortName?: string;
  address?: string;
  gstNumber?: string;
}

export interface OrganizationLocation {
  id: string;
  name: string;
}

export interface OrganizationExtended {
  id: string;
  name: string;
  shortName?: string;
  logoUrl?: string;
  address?: string;
  countryId?: string;
  stateId?: string;
  cityId?: string;
  country?: OrganizationLocation;
  state?: OrganizationLocation;
  city?: OrganizationLocation;
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
  depotCount?: number;
  warehouseCount?: number;
  accountingYearStart?: string;
  costCentres?: CostCentre[];
  branches?: Branch[];
  depots?: Depot[];
  warehouses?: Warehouse[];
  departmentsCount?: number;
  branchesCount?: number;
  costCentresCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

// Legacy Organization type (minimal) for backward compatibility
type Organization = OrganizationExtended;

export interface OrganizationFilters {
  status?: 'active' | 'inactive' | 'suspended';
  search?: string;
  page?: number;
  limit?: number;
}

export interface OrganizationStats {
  totalUsers: number;
  totalTasks: number;
  activeTasks: number;
  completedTasks: number;
  overdueTasks: number;
}

/**
 * Get all organizations with filters and pagination
 */
export async function getAllOrganizations(filters: OrganizationFilters = {}) {
  const {
    status,
    search,
    page = 1,
    limit = 20,
  } = filters;

  let whereConditions: string[] = [];
  const queryParams: any[] = [];
  let paramIndex = 1;

  if (status) {
    whereConditions.push(`status = $${paramIndex}`);
    queryParams.push(status);
    paramIndex++;
  }

  if (search) {
    whereConditions.push(`(name ILIKE $${paramIndex} OR email ILIKE $${paramIndex} OR mobile ILIKE $${paramIndex})`);
    queryParams.push(`%${search}%`);
    paramIndex++;
  }

  const whereClause = whereConditions.length > 0
    ? `WHERE ${whereConditions.join(' AND ')}`
    : '';

  const offset = (page - 1) * limit;

  // Get total count
  const countResult = await query(
    `SELECT COUNT(*) as total FROM organizations ${whereClause}`,
    queryParams
  );
  const total = parseInt(countResult.rows[0].total, 10);

  // Get organizations (with Entity Master columns)
  const result = await query(
    `SELECT 
      id, name, short_name, logo_url, address,
      country_id, state_id, city_id, pin_code, address_line1, address_line2,
      email, mobile, website, phone_number,
      gst, pan, cin, org_constitution, depot_count, warehouse_count,
      accounting_year_start, created_at, updated_at,
      CASE 
        WHEN EXISTS (SELECT 1 FROM user_organizations WHERE organization_id = organizations.id) THEN 'active'
        ELSE 'inactive'
      END as status
    FROM organizations 
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...queryParams, limit, offset]
  );

  return {
    organizations: result.rows.map((r: any) => mapOrganization(r)),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get organization by ID (with country, state, city, cost centres, branches, counts)
 */
export async function getOrganizationById(id: string): Promise<OrganizationExtended | null> {
  const result = await query(
    `SELECT 
      o.id, o.name, o.short_name, o.logo_url, o.address,
      o.country_id, o.state_id, o.city_id,
      o.pin_code, o.address_line1, o.address_line2,
      o.email, o.mobile, o.website, o.phone_number,
      o.gst, o.pan, o.cin, o.org_constitution,
      o.depot_count, o.warehouse_count,
      o.accounting_year_start, o.created_at, o.updated_at,
      c.name as country_name,
      s.name as state_name,
      ci.name as city_name
    FROM organizations o
    LEFT JOIN countries c ON o.country_id = c.id
    LEFT JOIN states s ON o.state_id = s.id
    LEFT JOIN cities ci ON o.city_id = ci.id
    WHERE o.id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  const org = mapOrganization(row);

  // Defensive: if branches/cost_centres tables don't exist yet (migration not run), return empty
  const queryOptional = async (sql: string, params: any[]): Promise<{ rows: any[] }> => {
    try {
      return await query(sql, params);
    } catch (err: any) {
      if (err.code === '42P01') return { rows: [] }; // relation does not exist
      throw err;
    }
  };

  const [costCentresResult, branchesResult, depotsResult, warehousesResult, deptCountResult] = await Promise.all([
    queryOptional('SELECT id, name, short_name, display_order FROM cost_centres WHERE organization_id = $1 ORDER BY display_order, name', [id]),
    queryOptional('SELECT id, name, short_name, address, gst_number FROM branches WHERE organization_id = $1 ORDER BY name', [id]),
    queryOptional('SELECT id, name, short_name, display_order FROM depots WHERE organization_id = $1 ORDER BY display_order, name', [id]),
    queryOptional('SELECT id, name, short_name, address, gst_number FROM warehouses WHERE organization_id = $1 ORDER BY name', [id]),
    queryOptional('SELECT COUNT(*) as total FROM departments WHERE organization_id = $1', [id]),
  ]);

  (org as OrganizationExtended).costCentres = costCentresResult.rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    shortName: r.short_name,
    displayOrder: r.display_order,
  }));
  (org as OrganizationExtended).branches = branchesResult.rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    shortName: r.short_name,
    address: r.address,
    gstNumber: r.gst_number,
  }));
  (org as OrganizationExtended).depots = depotsResult.rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    shortName: r.short_name,
    displayOrder: r.display_order,
  }));
  (org as OrganizationExtended).warehouses = warehousesResult.rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    shortName: r.short_name,
    address: r.address,
    gstNumber: r.gst_number,
  }));
  (org as OrganizationExtended).departmentsCount = parseInt(deptCountResult.rows[0]?.total || '0', 10);
  (org as OrganizationExtended).branchesCount = branchesResult.rows.length;
  (org as OrganizationExtended).costCentresCount = costCentresResult.rows.length;

  return org as OrganizationExtended;
}

/**
 * Create a new organization (with Entity Master fields)
 */
export async function createOrganization(data: {
  name: string;
  shortName?: string;
  logoUrl?: string;
  address?: string;
  countryId?: string;
  stateId?: string;
  cityId?: string;
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
  depotCount?: number;
  warehouseCount?: number;
  accountingYearStart?: string;
}): Promise<OrganizationExtended> {
  const result = await query(
    `INSERT INTO organizations 
    (name, short_name, logo_url, address, country_id, state_id, city_id,
     pin_code, address_line1, address_line2, email, mobile, website, phone_number,
     gst, pan, cin, org_constitution, depot_count, warehouse_count, accounting_year_start)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
    RETURNING id, name, short_name, logo_url, address, country_id, state_id, city_id,
      pin_code, address_line1, address_line2, email, mobile, website, phone_number,
      gst, pan, cin, org_constitution, depot_count, warehouse_count,
      accounting_year_start, created_at, updated_at`,
    [
      data.name,
      data.shortName || null,
      data.logoUrl || null,
      data.address || null,
      data.countryId || null,
      data.stateId || null,
      data.cityId || null,
      data.pinCode || null,
      data.addressLine1 || null,
      data.addressLine2 || null,
      data.email || null,
      data.mobile || null,
      data.website || null,
      data.phoneNumber || null,
      data.gst || null,
      data.pan || null,
      data.cin || null,
      data.orgConstitution || null,
      data.depotCount ?? 0,
      data.warehouseCount ?? 0,
      data.accountingYearStart || null,
    ]
  );

  return mapOrganization(result.rows[0]);
}

/**
 * Update organization (with Entity Master fields)
 */
export async function updateOrganization(
  id: string,
  data: Partial<{
    name: string;
    shortName: string;
    logoUrl: string;
    address: string;
    countryId: string;
    stateId: string;
    cityId: string;
    pinCode: string;
    addressLine1: string;
    addressLine2: string;
    email: string;
    mobile: string;
    website: string;
    phoneNumber: string;
    gst: string;
    pan: string;
    cin: string;
    orgConstitution: string;
    depotCount: number;
    warehouseCount: number;
    accountingYearStart: string;
  }>
): Promise<OrganizationExtended | null> {
  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  const fields: Array<[string, string, any]> = [
    ['name', 'name', data.name],
    ['shortName', 'short_name', data.shortName],
    ['logoUrl', 'logo_url', data.logoUrl],
    ['address', 'address', data.address],
    ['countryId', 'country_id', data.countryId],
    ['stateId', 'state_id', data.stateId],
    ['cityId', 'city_id', data.cityId],
    ['pinCode', 'pin_code', data.pinCode],
    ['addressLine1', 'address_line1', data.addressLine1],
    ['addressLine2', 'address_line2', data.addressLine2],
    ['email', 'email', data.email],
    ['mobile', 'mobile', data.mobile],
    ['website', 'website', data.website],
    ['phoneNumber', 'phone_number', data.phoneNumber],
    ['gst', 'gst', data.gst],
    ['pan', 'pan', data.pan],
    ['cin', 'cin', data.cin],
    ['orgConstitution', 'org_constitution', data.orgConstitution],
    ['depotCount', 'depot_count', data.depotCount],
    ['warehouseCount', 'warehouse_count', data.warehouseCount],
    ['accountingYearStart', 'accounting_year_start', data.accountingYearStart],
  ];
  const emptyToNullFields = ['country_id', 'state_id', 'city_id', 'accounting_year_start'];
  for (const [, col, val] of fields) {
    if (val !== undefined) {
      updates.push(`${col} = $${paramIndex++}`);
      const needsNull = emptyToNullFields.includes(col) && (val === '' || val == null);
      values.push(needsNull ? null : val);
    }
  }

  if (updates.length === 0) {
    return getOrganizationById(id);
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  const result = await query(
    `UPDATE organizations 
    SET ${updates.join(', ')}
    WHERE id = $${paramIndex}
    RETURNING id, name, short_name, logo_url, address, country_id, state_id, city_id,
      pin_code, address_line1, address_line2, email, mobile, website, phone_number,
      gst, pan, cin, org_constitution, depot_count, warehouse_count,
      accounting_year_start, created_at, updated_at`,
    values
  );

  if (result.rows.length === 0) {
    return null;
  }

  return mapOrganization(result.rows[0]);
}

/**
 * Get cost centres for an organization (returns [] if cost_centres table does not exist yet)
 */
export async function getCostCentresByOrganizationId(organizationId: string): Promise<CostCentre[]> {
  try {
    const result = await query(
      'SELECT id, name, short_name, display_order FROM cost_centres WHERE organization_id = $1 ORDER BY display_order, name',
      [organizationId]
    );
    return result.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      shortName: r.short_name,
      displayOrder: r.display_order,
    }));
  } catch (err: any) {
    if (err.code === '42P01') return []; // relation "cost_centres" does not exist
    throw err;
  }
}

/**
 * Create a cost centre
 */
export async function createCostCentre(organizationId: string, data: { name: string; shortName?: string; displayOrder?: number }): Promise<CostCentre> {
  const result = await query(
    `INSERT INTO cost_centres (organization_id, name, short_name, display_order)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, short_name, display_order`,
    [organizationId, data.name, data.shortName || null, data.displayOrder ?? 0]
  );
  const r = result.rows[0];
  return { id: r.id, name: r.name, shortName: r.short_name, displayOrder: r.display_order };
}

/**
 * Update a cost centre
 */
export async function updateCostCentre(costCentreId: string, data: Partial<{ name: string; shortName: string; displayOrder: number }>): Promise<CostCentre | null> {
  const updates: string[] = [];
  const values: any[] = [];
  let i = 1;
  if (data.name !== undefined) { updates.push(`name = $${i++}`); values.push(data.name); }
  if (data.shortName !== undefined) { updates.push(`short_name = $${i++}`); values.push(data.shortName); }
  if (data.displayOrder !== undefined) { updates.push(`display_order = $${i++}`); values.push(data.displayOrder); }
  if (updates.length === 0) return null;
  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(costCentreId);
  const result = await query(
    `UPDATE cost_centres SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, name, short_name, display_order`,
    values
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  return { id: r.id, name: r.name, shortName: r.short_name, displayOrder: r.display_order };
}

/**
 * Delete a cost centre
 */
export async function deleteCostCentre(costCentreId: string): Promise<boolean> {
  const result = await query('DELETE FROM cost_centres WHERE id = $1', [costCentreId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Get branches for an organization (returns [] if branches table does not exist yet)
 */
export async function getBranchesByOrganizationId(organizationId: string): Promise<Branch[]> {
  try {
    const result = await query(
      'SELECT id, name, short_name, address, gst_number FROM branches WHERE organization_id = $1 ORDER BY name',
      [organizationId]
    );
    return result.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      shortName: r.short_name,
      address: r.address,
      gstNumber: r.gst_number,
    }));
  } catch (err: any) {
    if (err.code === '42P01') return []; // relation "branches" does not exist
    throw err;
  }
}

/**
 * Create a branch
 */
export async function createBranch(organizationId: string, data: { name: string; shortName?: string; address?: string; gstNumber?: string }): Promise<Branch> {
  const result = await query(
    `INSERT INTO branches (organization_id, name, short_name, address, gst_number)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, short_name, address, gst_number`,
    [organizationId, data.name, data.shortName || null, data.address || null, data.gstNumber || null]
  );
  const r = result.rows[0];
  return { id: r.id, name: r.name, shortName: r.short_name, address: r.address, gstNumber: r.gst_number };
}

/**
 * Update a branch
 */
export async function updateBranch(branchId: string, data: Partial<{ name: string; shortName: string; address: string; gstNumber: string }>): Promise<Branch | null> {
  const updates: string[] = [];
  const values: any[] = [];
  let i = 1;
  if (data.name !== undefined) { updates.push(`name = $${i++}`); values.push(data.name); }
  if (data.shortName !== undefined) { updates.push(`short_name = $${i++}`); values.push(data.shortName); }
  if (data.address !== undefined) { updates.push(`address = $${i++}`); values.push(data.address); }
  if (data.gstNumber !== undefined) { updates.push(`gst_number = $${i++}`); values.push(data.gstNumber); }
  if (updates.length === 0) return null;
  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(branchId);
  const result = await query(
    `UPDATE branches SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, name, short_name, address, gst_number`,
    values
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  return { id: r.id, name: r.name, shortName: r.short_name, address: r.address, gstNumber: r.gst_number };
}

/**
 * Delete a branch
 */
export async function deleteBranch(branchId: string): Promise<boolean> {
  const result = await query('DELETE FROM branches WHERE id = $1', [branchId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Get depots for an organization (returns [] if depots table does not exist yet)
 */
export async function getDepotsByOrganizationId(organizationId: string): Promise<Depot[]> {
  try {
    const result = await query(
      'SELECT id, name, short_name, display_order FROM depots WHERE organization_id = $1 ORDER BY display_order, name',
      [organizationId]
    );
    return result.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      shortName: r.short_name,
      displayOrder: r.display_order,
    }));
  } catch (err: any) {
    if (err.code === '42P01') return []; // relation "depots" does not exist
    throw err;
  }
}

/**
 * Create a depot
 */
export async function createDepot(organizationId: string, data: { name: string; shortName?: string; displayOrder?: number }): Promise<Depot> {
  const result = await query(
    `INSERT INTO depots (organization_id, name, short_name, display_order)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, short_name, display_order`,
    [organizationId, data.name, data.shortName || null, data.displayOrder ?? 0]
  );
  const r = result.rows[0];
  return { id: r.id, name: r.name, shortName: r.short_name, displayOrder: r.display_order };
}

/**
 * Update a depot
 */
export async function updateDepot(depotId: string, data: Partial<{ name: string; shortName: string; displayOrder: number }>): Promise<Depot | null> {
  const updates: string[] = [];
  const values: any[] = [];
  let i = 1;
  if (data.name !== undefined) { updates.push(`name = $${i++}`); values.push(data.name); }
  if (data.shortName !== undefined) { updates.push(`short_name = $${i++}`); values.push(data.shortName); }
  if (data.displayOrder !== undefined) { updates.push(`display_order = $${i++}`); values.push(data.displayOrder); }
  if (updates.length === 0) return null;
  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(depotId);
  const result = await query(
    `UPDATE depots SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, name, short_name, display_order`,
    values
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  return { id: r.id, name: r.name, shortName: r.short_name, displayOrder: r.display_order };
}

/**
 * Delete a depot
 */
export async function deleteDepot(depotId: string): Promise<boolean> {
  const result = await query('DELETE FROM depots WHERE id = $1', [depotId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Get warehouses for an organization (returns [] if warehouses table does not exist yet)
 */
export async function getWarehousesByOrganizationId(organizationId: string): Promise<Warehouse[]> {
  try {
    const result = await query(
      'SELECT id, name, short_name, address, gst_number FROM warehouses WHERE organization_id = $1 ORDER BY name',
      [organizationId]
    );
    return result.rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      shortName: r.short_name,
      address: r.address,
      gstNumber: r.gst_number,
    }));
  } catch (err: any) {
    if (err.code === '42P01') return []; // relation "warehouses" does not exist
    throw err;
  }
}

/**
 * Create a warehouse
 */
export async function createWarehouse(organizationId: string, data: { name: string; shortName?: string; address?: string; gstNumber?: string }): Promise<Warehouse> {
  const result = await query(
    `INSERT INTO warehouses (organization_id, name, short_name, address, gst_number)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, short_name, address, gst_number`,
    [organizationId, data.name, data.shortName || null, data.address || null, data.gstNumber || null]
  );
  const r = result.rows[0];
  return { id: r.id, name: r.name, shortName: r.short_name, address: r.address, gstNumber: r.gst_number };
}

/**
 * Update a warehouse
 */
export async function updateWarehouse(warehouseId: string, data: Partial<{ name: string; shortName: string; address: string; gstNumber: string }>): Promise<Warehouse | null> {
  const updates: string[] = [];
  const values: any[] = [];
  let i = 1;
  if (data.name !== undefined) { updates.push(`name = $${i++}`); values.push(data.name); }
  if (data.shortName !== undefined) { updates.push(`short_name = $${i++}`); values.push(data.shortName); }
  if (data.address !== undefined) { updates.push(`address = $${i++}`); values.push(data.address); }
  if (data.gstNumber !== undefined) { updates.push(`gst_number = $${i++}`); values.push(data.gstNumber); }
  if (updates.length === 0) return null;
  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(warehouseId);
  const result = await query(
    `UPDATE warehouses SET ${updates.join(', ')} WHERE id = $${i} RETURNING id, name, short_name, address, gst_number`,
    values
  );
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  return { id: r.id, name: r.name, shortName: r.short_name, address: r.address, gstNumber: r.gst_number };
}

/**
 * Delete a warehouse
 */
export async function deleteWarehouse(warehouseId: string): Promise<boolean> {
  const result = await query('DELETE FROM warehouses WHERE id = $1', [warehouseId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Suspend organization (mark all users as inactive)
 */
export async function suspendOrganization(id: string): Promise<boolean> {
  // Update all users in this organization to inactive
  await query(
    `UPDATE users 
    SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT user_id FROM user_organizations WHERE organization_id = $1
    )`,
    [id]
  );

  return true;
}

/**
 * Activate organization (mark all users as active)
 */
export async function activateOrganization(id: string): Promise<boolean> {
  // Update all users in this organization to active
  await query(
    `UPDATE users 
    SET status = 'active', updated_at = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT user_id FROM user_organizations WHERE organization_id = $1
    )`,
    [id]
  );

  return true;
}

/**
 * Get organization users
 */
export async function getOrganizationUsers(organizationId: string) {
  const result = await query(
    `SELECT 
      u.id, u.mobile, u.name, u.role, u.status, u.profile_photo_url, u.bio,
      u.created_at, u.updated_at,
      uo.department, uo.designation, uo.reporting_to
    FROM users u
    INNER JOIN user_organizations uo ON u.id = uo.user_id
    WHERE uo.organization_id = $1
    ORDER BY u.created_at DESC`,
    [organizationId]
  );

  return result.rows.map(row => ({
    id: row.id,
    mobile: row.mobile,
    name: row.name,
    role: row.role,
    status: row.status,
    profilePhotoUrl: row.profile_photo_url,
    bio: row.bio,
    department: row.department,
    designation: row.designation,
    reportingTo: row.reporting_to,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

/**
 * Get organization tasks
 */
export async function getOrganizationTasks(organizationId: string, filters: {
  status?: string;
  page?: number;
  limit?: number;
} = {}) {
  const { status, page = 1, limit = 20 } = filters;
  const offset = (page - 1) * limit;

  let whereClause = 'WHERE t.organization_id = $1';
  const params: any[] = [organizationId];

  if (status) {
    whereClause += ' AND t.status = $2';
    params.push(status);
  }

  const countResult = await query(
    `SELECT COUNT(*) as total FROM tasks t ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].total, 10);

  const result = await query(
    `SELECT 
      t.id, t.title, t.description, t.task_type, t.creator_id, t.organization_id,
      t.start_date, t.target_date, t.due_date, t.frequency, t.specific_weekday,
      t.next_recurrence_date, t.category, t.status, t.escalation_status,
      t.created_at, t.updated_at
    FROM tasks t
    ${whereClause}
    ORDER BY t.created_at DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return {
    tasks: result.rows.map(mapTask),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Delete organization and all related data
 */
export async function deleteOrganization(id: string): Promise<boolean> {
  // Use transaction to ensure all related data is deleted
  const client = await pool.connect();
  
  // Helper function to execute query with savepoint for error handling
  const executeWithSavepoint = async (savepointName: string, query: string, params: any[]) => {
    try {
      await client.query(`SAVEPOINT ${savepointName}`);
      await client.query(query, params);
      await client.query(`RELEASE SAVEPOINT ${savepointName}`);
    } catch (err: any) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      // Only throw if it's not a "does not exist" error
      if (!err.message.includes('does not exist') && !err.message.includes('column')) {
        throw err;
      }
    }
  };
  
  try {
    await client.query('BEGIN');
    
    // Delete in order to respect foreign key constraints
    
    // 1. Delete group_members (through groups)
    await executeWithSavepoint(
      'sp_group_members',
      `DELETE FROM group_members 
       WHERE group_id IN (SELECT id FROM groups WHERE organization_id = $1)`,
      [id]
    );
    
    // 2. Delete task_assignments (through tasks)
    await executeWithSavepoint(
      'sp_task_assignments',
      `DELETE FROM task_assignments 
       WHERE task_id IN (SELECT id FROM tasks WHERE organization_id = $1)`,
      [id]
    );
    
    // 3. Delete message_status first (to avoid foreign key issues)
    await executeWithSavepoint(
      'sp_message_status',
      `DELETE FROM message_status 
       WHERE message_id IN (
         SELECT id FROM messages 
         WHERE conversation_id IN (
           SELECT id FROM conversations 
           WHERE group_id IN (SELECT id FROM groups WHERE organization_id = $1)
         )
       )`,
      [id]
    );
    
    // 4. Delete messages (if they have organization_id or through conversations)
    // First, try deleting messages in conversations associated with organization groups
    try {
      await client.query('SAVEPOINT sp_messages');
      await client.query(
        `DELETE FROM messages 
         WHERE conversation_id IN (
           SELECT id FROM conversations 
           WHERE group_id IN (SELECT id FROM groups WHERE organization_id = $1)
         )`,
        [id]
      );
      await client.query('RELEASE SAVEPOINT sp_messages');
    } catch (err: any) {
      await client.query('ROLLBACK TO SAVEPOINT sp_messages');
      // If that fails, try deleting messages directly if they have organization_id
      if (err.message.includes('does not exist') || err.message.includes('column')) {
        await executeWithSavepoint(
          'sp_messages_direct',
          'DELETE FROM messages WHERE organization_id = $1',
          [id]
        );
      } else {
        throw err;
      }
    }
    
    // 5. Delete conversations (through groups)
    await executeWithSavepoint(
      'sp_conversations',
      `DELETE FROM conversations 
       WHERE group_id IN (SELECT id FROM groups WHERE organization_id = $1)`,
      [id]
    );
    
    // 6. Delete groups associated with this organization
    await executeWithSavepoint(
      'sp_groups',
      'DELETE FROM groups WHERE organization_id = $1',
      [id]
    );
    
    // 7. Delete tasks
    await executeWithSavepoint(
      'sp_tasks',
      'DELETE FROM tasks WHERE organization_id = $1',
      [id]
    );
    
    // 8. Delete document instances (if they have organization_id)
    await executeWithSavepoint(
      'sp_document_instances',
      'DELETE FROM document_instances WHERE organization_id = $1',
      [id]
    );
    
    // 9. Delete documents (if they have organization_id)
    await executeWithSavepoint(
      'sp_documents',
      'DELETE FROM documents WHERE organization_id = $1',
      [id]
    );
    
    // 10. Delete compliance items (if they have organization_id)
    await executeWithSavepoint(
      'sp_compliance_items',
      'DELETE FROM compliance_items WHERE organization_id = $1',
      [id]
    );
    
    // 11. Delete departments (if they have organization_id)
    await executeWithSavepoint(
      'sp_departments',
      'DELETE FROM departments WHERE organization_id = $1',
      [id]
    );
    
    // 12. Delete designations (if they have organization_id)
    await executeWithSavepoint(
      'sp_designations',
      'DELETE FROM designations WHERE organization_id = $1',
      [id]
    );

    // 12a. Delete cost_centres and branches
    await executeWithSavepoint('sp_cost_centres', 'DELETE FROM cost_centres WHERE organization_id = $1', [id]);
    await executeWithSavepoint('sp_branches', 'DELETE FROM branches WHERE organization_id = $1', [id]);
    
    // 13. Delete user_organizations relationships (required - must succeed)
    await client.query(
      'DELETE FROM user_organizations WHERE organization_id = $1',
      [id]
    );
    
    // 14. Finally delete the organization (required - must succeed)
    await client.query(
      'DELETE FROM organizations WHERE id = $1',
      [id]
    );
    
    await client.query('COMMIT');
    return true;
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Error deleting organization:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get organization statistics
 */
export async function getOrganizationStats(organizationId: string): Promise<OrganizationStats> {
  const usersResult = await query(
    `SELECT COUNT(*) as total FROM user_organizations WHERE organization_id = $1`,
    [organizationId]
  );
  const totalUsers = parseInt(usersResult.rows[0].total, 10);

  const tasksResult = await query(
    `SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'in_progress') as active,
      COUNT(*) FILTER (WHERE status = 'completed') as completed,
      COUNT(*) FILTER (WHERE status = 'overdue') as overdue
    FROM tasks
    WHERE organization_id = $1`,
    [organizationId]
  );

  const row = tasksResult.rows[0];
  return {
    totalUsers,
    totalTasks: parseInt(row.total, 10),
    activeTasks: parseInt(row.active, 10),
    completedTasks: parseInt(row.completed, 10),
    overdueTasks: parseInt(row.overdue, 10),
  };
}

/**
 * Map database row to Organization type (with Entity Master fields)
 */
function mapOrganization(row: any): OrganizationExtended {
  const org: OrganizationExtended = {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    logoUrl: row.logo_url,
    address: row.address,
    countryId: row.country_id,
    stateId: row.state_id,
    cityId: row.city_id,
    country: row.country_id && row.country_name ? { id: row.country_id, name: row.country_name } : undefined,
    state: row.state_id && row.state_name ? { id: row.state_id, name: row.state_name } : undefined,
    city: row.city_id && row.city_name ? { id: row.city_id, name: row.city_name } : undefined,
    pinCode: row.pin_code,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    email: row.email,
    mobile: row.mobile,
    website: row.website,
    phoneNumber: row.phone_number,
    gst: row.gst,
    pan: row.pan,
    cin: row.cin,
    orgConstitution: row.org_constitution,
    depotCount: row.depot_count != null ? row.depot_count : 0,
    warehouseCount: row.warehouse_count != null ? row.warehouse_count : 0,
    accountingYearStart: row.accounting_year_start
      ? (typeof row.accounting_year_start === 'string' ? row.accounting_year_start : row.accounting_year_start.toISOString().split('T')[0])
      : undefined,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
  return org;
}

/**
 * Map database row to Task type
 */
function mapTask(row: any) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    taskType: row.task_type,
    creatorId: row.creator_id,
    organizationId: row.organization_id,
    startDate: row.start_date ? row.start_date.toISOString() : undefined,
    targetDate: row.target_date ? row.target_date.toISOString() : undefined,
    dueDate: row.due_date ? row.due_date.toISOString() : undefined,
    frequency: row.frequency,
    specificWeekday: row.specific_weekday,
    nextRecurrenceDate: row.next_recurrence_date
      ? row.next_recurrence_date.toISOString()
      : undefined,
    category: row.category,
    status: row.status,
    escalationStatus: row.escalation_status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

