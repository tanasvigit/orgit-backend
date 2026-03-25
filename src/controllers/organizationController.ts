import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import * as organizationService from '../services/organizationService';
import { ORG_CONSTITUTION_VALUES } from '../services/masterDataService';
import { query } from '../config/database';

const PAN_REGEX = /^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/;

function validateAndNormalizePan(pan: string | undefined): string | null {
  if (pan == null || pan === '') return null;
  const trimmed = pan.trim().toUpperCase();
  if (!trimmed) return null;
  if (!PAN_REGEX.test(trimmed)) {
    throw new Error('PAN must be 5 letters, 4 digits, 1 letter (e.g. ABCDE1234F)');
  }
  return trimmed;
}

function getEntityMasterBody(body: any) {
  const pan = body.pan != null ? validateAndNormalizePan(body.pan) : undefined;
  const orgConstitution = body.orgConstitution ?? body.org_constitution;
  if (orgConstitution != null && orgConstitution !== '' && !ORG_CONSTITUTION_VALUES.includes(orgConstitution)) {
    throw new Error(`orgConstitution must be one of: ${ORG_CONSTITUTION_VALUES.join(', ')}`);
  }
  return {
    shortName: body.shortName ?? body.short_name,
    countryId: body.countryId ?? body.country_id,
    stateId: body.stateId ?? body.state_id,
    cityId: body.cityId ?? body.city_id,
    countryName: body.countryName ?? body.country_name,
    stateName: body.stateName ?? body.state_name,
    cityName: body.cityName ?? body.city_name,
    pinCode: body.pinCode ?? body.pin_code,
    addressLine1: body.addressLine1 ?? body.address_line1,
    addressLine2: body.addressLine2 ?? body.address_line2,
    website: body.website,
    phoneNumber: body.phoneNumber ?? body.phone_number,
    orgConstitution: orgConstitution || undefined,
    pan: pan !== undefined ? pan : body.pan,
    depotCount: body.depotCount ?? body.depot_count,
    warehouseCount: body.warehouseCount ?? body.warehouse_count,
  };
}

/** Resolve country/state/city names to IDs and set on entityMaster (for UI form submit). */
async function resolveAddressNames(entityMaster: ReturnType<typeof getEntityMasterBody>): Promise<void> {
  if (entityMaster.countryName && typeof entityMaster.countryName === 'string' && entityMaster.countryName.trim() && !entityMaster.countryId) {
    const r = await query('SELECT id FROM countries WHERE LOWER(TRIM(name)) = LOWER(TRIM($1)) LIMIT 1', [entityMaster.countryName.trim()]);
    if (r.rows.length > 0) entityMaster.countryId = r.rows[0].id;
  }
  if (entityMaster.stateName && typeof entityMaster.stateName === 'string' && entityMaster.stateName.trim() && entityMaster.countryId && !entityMaster.stateId) {
    const r = await query('SELECT id FROM states WHERE country_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2)) LIMIT 1', [entityMaster.countryId, entityMaster.stateName.trim()]);
    if (r.rows.length > 0) entityMaster.stateId = r.rows[0].id;
  }
  if (entityMaster.cityName && typeof entityMaster.cityName === 'string' && entityMaster.cityName.trim() && entityMaster.stateId && !entityMaster.cityId) {
    const r = await query('SELECT id FROM cities WHERE state_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2)) LIMIT 1', [entityMaster.stateId, entityMaster.cityName.trim()]);
    if (r.rows.length > 0) entityMaster.cityId = r.rows[0].id;
  }
}

/**
 * Get all organizations
 */
export async function getAllOrganizations(req: AuthRequest, res: Response) {
  try {
    const filters = {
      status: req.query.status as string | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
    };

    const result = await organizationService.getAllOrganizations(filters);

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('Error getting organizations:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get organizations',
    });
  }
}

/**
 * Get organization by ID
 */
export async function getOrganizationById(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const organization = await organizationService.getOrganizationById(id);

    if (!organization) {
      return res.status(404).json({
        success: false,
        error: 'Organization not found',
      });
    }

    res.json({
      success: true,
      data: organization,
    });
  } catch (error: any) {
    console.error('Error getting organization:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get organization',
    });
  }
}

/**
 * Create organization for admin (if they don't have one)
 */
export async function createAdminOrganization(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    // Check if admin already has an organization
    const existingOrg = await query(
      `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    if (existingOrg.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'You already have an organization. Use update endpoint to modify it.',
      });
    }

    const {
      name,
      logoUrl,
      address,
      email,
      mobile,
      gst,
      pan,
      cin,
      accountingYearStart,
      costCentres,
      branches,
      depots,
      warehouses,
      ...rest
    } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Organization name is required',
      });
    }

    let entityMaster: ReturnType<typeof getEntityMasterBody>;
    try {
      entityMaster = getEntityMasterBody({ ...req.body, pan });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
    await resolveAddressNames(entityMaster);

    // Create organization
    const organization = await organizationService.createOrganization({
      name,
      shortName: entityMaster.shortName,
      logoUrl,
      address,
      countryId: entityMaster.countryId,
      stateId: entityMaster.stateId,
      cityId: entityMaster.cityId,
      pinCode: entityMaster.pinCode,
      addressLine1: entityMaster.addressLine1,
      addressLine2: entityMaster.addressLine2,
      email,
      mobile,
      website: entityMaster.website,
      phoneNumber: entityMaster.phoneNumber,
      gst,
      pan: entityMaster.pan,
      cin,
      orgConstitution: entityMaster.orgConstitution,
      depotCount: entityMaster.depotCount,
      warehouseCount: entityMaster.warehouseCount,
      accountingYearStart,
    });

    // Create cost centres and branches if provided
    if (Array.isArray(costCentres) && costCentres.length > 0) {
      for (let i = 0; i < costCentres.length; i++) {
        const cc = costCentres[i];
        if (cc && cc.name) {
          await organizationService.createCostCentre(organization.id, {
            name: cc.name,
            shortName: cc.shortName ?? cc.short_name,
            displayOrder: cc.displayOrder ?? cc.display_order ?? i,
          });
        }
      }
    }
    if (Array.isArray(branches) && branches.length > 0) {
      for (const b of branches) {
        if (b && b.name) {
          await organizationService.createBranch(organization.id, {
            name: b.name,
            shortName: b.shortName ?? b.short_name,
            address: b.address,
            gstNumber: b.gstNumber ?? b.gst_number,
          });
        }
      }
    }

    // Link admin to the organization
    await query(
      `INSERT INTO user_organizations (id, user_id, organization_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, organization_id) DO NOTHING`,
      [userId, organization.id]
    );

    const fullOrg = await organizationService.getOrganizationById(organization.id);
    res.status(201).json({
      success: true,
      data: fullOrg ?? organization,
    });
  } catch (error: any) {
    console.error('Error creating admin organization:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create organization',
    });
  }
}

/**
 * Get organization data for document auto-fill (accessible by all authenticated users with organization)
 */
export async function getMyOrganizationData(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You must be part of an organization to access organization data',
      });
    }

    const organization = await organizationService.getOrganizationById(organizationId);

    if (!organization) {
      return res.status(404).json({
        success: false,
        error: 'Organization not found',
      });
    }

    // Return organization data for document auto-fill and entity master (with new Entity Master fields)
    res.json({
      success: true,
      data: {
        id: organization.id,
        name: organization.name,
        shortName: organization.shortName,
        logo_url: organization.logoUrl,
        address: organization.address,
        countryId: organization.countryId,
        stateId: organization.stateId,
        cityId: organization.cityId,
        country: organization.country,
        state: organization.state,
        city: organization.city,
        pinCode: organization.pinCode,
        addressLine1: organization.addressLine1,
        addressLine2: organization.addressLine2,
        email: organization.email,
        mobile: organization.mobile,
        website: organization.website,
        phoneNumber: organization.phoneNumber,
        gst: organization.gst,
        pan: organization.pan,
        cin: organization.cin,
        orgConstitution: organization.orgConstitution,
        depotCount: organization.depotCount,
        warehouseCount: organization.warehouseCount,
        costCentres: organization.costCentres,
        branches: organization.branches,
        departmentsCount: organization.departmentsCount,
        branchesCount: organization.branchesCount,
        costCentresCount: organization.costCentresCount,
        logoUrl: organization.logoUrl, // For backward compatibility
      },
    });
  } catch (error: any) {
    console.error('Error getting organization data:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get organization data',
    });
  }
}

/**
 * Get admin's own organization
 */
export async function getAdminOrganization(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    // Check if admin has an organization
    const existingOrg = await query(
      `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    if (existingOrg.rows.length === 0) {
      // Admin doesn't have an organization yet - return null/empty data
      return res.json({
        success: true,
        data: null,
      });
    }

    const organizationId = existingOrg.rows[0].organization_id;
    const organization = await organizationService.getOrganizationById(organizationId);

    if (!organization) {
      return res.status(404).json({
        success: false,
        error: 'Organization not found',
      });
    }

    res.json({
      success: true,
      data: organization,
    });
  } catch (error: any) {
    console.error('Error getting admin organization:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get organization',
    });
  }
}

/**
 * Update admin's own organization (or create if doesn't exist)
 */
export async function updateAdminOrganization(req: AuthRequest, res: Response) {
  try {
    const userId = req.user?.userId;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const {
      name,
      logoUrl,
      address,
      email,
      mobile,
      gst,
      pan,
      cin,
      accountingYearStart,
      costCentres,
      branches,
      depots,
      warehouses,
      ...rest
    } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Organization name is required',
      });
    }

    let entityMaster: ReturnType<typeof getEntityMasterBody>;
    try {
      entityMaster = getEntityMasterBody({ ...req.body, pan });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
    await resolveAddressNames(entityMaster);

    const updatePayload = {
      name,
      shortName: entityMaster.shortName,
      logoUrl,
      address,
      countryId: entityMaster.countryId,
      stateId: entityMaster.stateId,
      cityId: entityMaster.cityId,
      pinCode: entityMaster.pinCode,
      addressLine1: entityMaster.addressLine1,
      addressLine2: entityMaster.addressLine2,
      email,
      mobile,
      website: entityMaster.website,
      phoneNumber: entityMaster.phoneNumber,
      gst,
      pan: entityMaster.pan,
      cin,
      orgConstitution: entityMaster.orgConstitution,
      depotCount: entityMaster.depotCount,
      warehouseCount: entityMaster.warehouseCount,
      accountingYearStart,
    };

    // Check if admin already has an organization
    const existingOrg = await query(
      `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
      [userId]
    );

    let organization: Awaited<ReturnType<typeof organizationService.getOrganizationById>>;

    if (existingOrg.rows.length > 0) {
      // Admin has an organization, update it
      const organizationId = existingOrg.rows[0].organization_id;
      organization = await organizationService.updateOrganization(organizationId, updatePayload);

      if (!organization) {
        return res.status(404).json({
          success: false,
          error: 'Organization not found',
        });
      }
      // If costCentres/branches arrays provided, replace: delete existing and create new (simple bulk replace)
      if (Array.isArray(costCentres)) {
        const existing = await organizationService.getCostCentresByOrganizationId(organizationId);
        for (const cc of existing) {
          await organizationService.deleteCostCentre(cc.id);
        }
        for (let i = 0; i < costCentres.length; i++) {
          const cc = costCentres[i];
          if (cc && cc.name) {
            await organizationService.createCostCentre(organizationId, {
              name: cc.name,
              shortName: cc.shortName ?? cc.short_name,
              displayOrder: cc.displayOrder ?? cc.display_order ?? i,
            });
          }
        }
      }
      if (Array.isArray(branches)) {
        const existing = await organizationService.getBranchesByOrganizationId(organizationId);
        for (const b of existing) {
          await organizationService.deleteBranch(b.id);
        }
        for (const b of branches) {
          if (b && b.name) {
            await organizationService.createBranch(organizationId, {
              name: b.name,
              shortName: b.shortName ?? b.short_name,
              address: b.address,
              gstNumber: b.gstNumber ?? b.gst_number,
            });
          }
        }
      }
      if (Array.isArray(depots)) {
        const existing = await organizationService.getDepotsByOrganizationId(organizationId);
        for (const d of existing) {
          await organizationService.deleteDepot(d.id);
        }
        for (let i = 0; i < depots.length; i++) {
          const d = depots[i];
          if (d && d.name) {
            await organizationService.createDepot(organizationId, {
              name: d.name,
              shortName: d.shortName ?? d.short_name,
              displayOrder: d.displayOrder ?? d.display_order ?? i,
            });
          }
        }
      }
      if (Array.isArray(warehouses)) {
        const existing = await organizationService.getWarehousesByOrganizationId(organizationId);
        for (const w of existing) {
          await organizationService.deleteWarehouse(w.id);
        }
        for (const w of warehouses) {
          if (w && w.name) {
            await organizationService.createWarehouse(organizationId, {
              name: w.name,
              shortName: w.shortName ?? w.short_name,
              address: w.address,
              gstNumber: w.gstNumber ?? w.gst_number,
            });
          }
        }
      }
      organization = await organizationService.getOrganizationById(organizationId);
    } else {
      // Admin doesn't have an organization, create one
      organization = await organizationService.createOrganization({
        name,
        ...updatePayload,
      });
      if (Array.isArray(costCentres) && costCentres.length > 0) {
        for (let i = 0; i < costCentres.length; i++) {
          const cc = costCentres[i];
          if (cc && cc.name) {
            await organizationService.createCostCentre(organization!.id, {
              name: cc.name,
              shortName: cc.shortName ?? cc.short_name,
              displayOrder: cc.displayOrder ?? cc.display_order ?? i,
            });
          }
        }
      }
      if (Array.isArray(branches) && branches.length > 0) {
        for (const b of branches) {
          if (b && b.name) {
            await organizationService.createBranch(organization!.id, {
              name: b.name,
              shortName: b.shortName ?? b.short_name,
              address: b.address,
              gstNumber: b.gstNumber ?? b.gst_number,
            });
          }
        }
      }
      if (Array.isArray(depots) && depots.length > 0) {
        for (let i = 0; i < depots.length; i++) {
          const d = depots[i];
          if (d && d.name) {
            await organizationService.createDepot(organization!.id, {
              name: d.name,
              shortName: d.shortName ?? d.short_name,
              displayOrder: d.displayOrder ?? d.display_order ?? i,
            });
          }
        }
      }
      if (Array.isArray(warehouses) && warehouses.length > 0) {
        for (const w of warehouses) {
          if (w && w.name) {
            await organizationService.createWarehouse(organization!.id, {
              name: w.name,
              shortName: w.shortName ?? w.short_name,
              address: w.address,
              gstNumber: w.gstNumber ?? w.gst_number,
            });
          }
        }
      }
      organization = await organizationService.getOrganizationById(organization!.id);

      // Link admin to the newly created organization
      await query(
        `INSERT INTO user_organizations (id, user_id, organization_id, created_at)
         VALUES (gen_random_uuid(), $1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id, organization_id) DO NOTHING`,
        [userId, organization.id]
      );
    }

    res.json({
      success: true,
      data: organization,
    });
  } catch (error: any) {
    console.error('Error updating admin organization:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update organization',
    });
  }
}

/**
 * Create organization (super-admin)
 */
export async function createOrganization(req: AuthRequest, res: Response) {
  try {
    const {
      name,
      logoUrl,
      address,
      email,
      mobile,
      gst,
      pan,
      cin,
      accountingYearStart,
      costCentres,
      branches,
      depots,
      warehouses,
    } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        error: 'Organization name is required',
      });
    }

    let entityMaster: ReturnType<typeof getEntityMasterBody>;
    try {
      entityMaster = getEntityMasterBody({ ...req.body, pan });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
    await resolveAddressNames(entityMaster);

    const organization = await organizationService.createOrganization({
      name,
      shortName: entityMaster.shortName,
      logoUrl,
      address,
      countryId: entityMaster.countryId,
      stateId: entityMaster.stateId,
      cityId: entityMaster.cityId,
      pinCode: entityMaster.pinCode,
      addressLine1: entityMaster.addressLine1,
      addressLine2: entityMaster.addressLine2,
      email,
      mobile,
      website: entityMaster.website,
      phoneNumber: entityMaster.phoneNumber,
      gst,
      pan: entityMaster.pan,
      cin,
      orgConstitution: entityMaster.orgConstitution,
      depotCount: entityMaster.depotCount,
      warehouseCount: entityMaster.warehouseCount,
      accountingYearStart,
    });

    if (Array.isArray(costCentres) && costCentres.length > 0) {
      for (let i = 0; i < costCentres.length; i++) {
        const cc = costCentres[i];
        if (cc && cc.name) {
          await organizationService.createCostCentre(organization.id, {
            name: cc.name,
            shortName: cc.shortName ?? cc.short_name,
            displayOrder: cc.displayOrder ?? cc.display_order ?? i,
          });
        }
      }
    }
    if (Array.isArray(branches) && branches.length > 0) {
      for (const b of branches) {
        if (b && b.name) {
          await organizationService.createBranch(organization.id, {
            name: b.name,
            shortName: b.shortName ?? b.short_name,
            address: b.address,
            gstNumber: b.gstNumber ?? b.gst_number,
          });
        }
      }
    }
    if (Array.isArray(depots) && depots.length > 0) {
      for (let i = 0; i < depots.length; i++) {
        const d = depots[i];
        if (d && d.name) {
          await organizationService.createDepot(organization.id, {
            name: d.name,
            shortName: d.shortName ?? d.short_name,
            displayOrder: d.displayOrder ?? d.display_order ?? i,
          });
        }
      }
    }
    if (Array.isArray(warehouses) && warehouses.length > 0) {
      for (const w of warehouses) {
        if (w && w.name) {
          await organizationService.createWarehouse(organization.id, {
            name: w.name,
            shortName: w.shortName ?? w.short_name,
            address: w.address,
            gstNumber: w.gstNumber ?? w.gst_number,
          });
        }
      }
    }

    const fullOrg = await organizationService.getOrganizationById(organization.id);
    res.status(201).json({
      success: true,
      data: fullOrg ?? organization,
    });
  } catch (error: any) {
    console.error('Error creating organization:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create organization',
    });
  }
}

/**
 * Update organization
 * Allows super admins to update any organization
 * Allows admins to update only their own organization
 */
export async function updateOrganization(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const {
      name,
      logoUrl,
      address,
      email,
      mobile,
      gst,
      pan,
      cin,
      accountingYearStart,
      costCentres,
      branches,
      depots,
      warehouses,
    } = req.body;

    let entityMaster: ReturnType<typeof getEntityMasterBody>;
    try {
      entityMaster = getEntityMasterBody({ ...req.body, pan });
    } catch (err: any) {
      return res.status(400).json({ success: false, error: err.message });
    }
    await resolveAddressNames(entityMaster);

    // If user is admin (not super_admin), verify they're updating their own organization
    if (req.user?.role === 'admin') {
      const { query } = await import('../config/database');
      const orgResult = await query(
        `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
        [req.user.userId]
      );

      if (orgResult.rows.length === 0) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: You are not associated with any organization',
        });
      }

      const userOrgId = orgResult.rows[0].organization_id;
      if (userOrgId !== id) {
        return res.status(403).json({
          success: false,
          error: 'Forbidden: You can only update your own organization',
        });
      }
    }

    const organization = await organizationService.updateOrganization(id, {
      name,
      shortName: entityMaster.shortName,
      logoUrl,
      address,
      countryId: entityMaster.countryId,
      stateId: entityMaster.stateId,
      cityId: entityMaster.cityId,
      pinCode: entityMaster.pinCode,
      addressLine1: entityMaster.addressLine1,
      addressLine2: entityMaster.addressLine2,
      email,
      mobile,
      website: entityMaster.website,
      phoneNumber: entityMaster.phoneNumber,
      gst,
      pan: entityMaster.pan,
      cin,
      orgConstitution: entityMaster.orgConstitution,
      depotCount: entityMaster.depotCount,
      warehouseCount: entityMaster.warehouseCount,
      accountingYearStart,
    });

    if (Array.isArray(costCentres)) {
      const existing = await organizationService.getCostCentresByOrganizationId(id);
      for (const cc of existing) {
        await organizationService.deleteCostCentre(cc.id);
      }
      for (let i = 0; i < costCentres.length; i++) {
        const cc = costCentres[i];
        if (cc && cc.name) {
          await organizationService.createCostCentre(id, {
            name: cc.name,
            shortName: cc.shortName ?? cc.short_name,
            displayOrder: cc.displayOrder ?? cc.display_order ?? i,
          });
        }
      }
    }
    if (Array.isArray(branches)) {
      const existing = await organizationService.getBranchesByOrganizationId(id);
      for (const b of existing) {
        await organizationService.deleteBranch(b.id);
      }
      for (const b of branches) {
        if (b && b.name) {
          await organizationService.createBranch(id, {
            name: b.name,
            shortName: b.shortName ?? b.short_name,
            address: b.address,
            gstNumber: b.gstNumber ?? b.gst_number,
          });
        }
      }
    }
    if (Array.isArray(depots)) {
      const existing = await organizationService.getDepotsByOrganizationId(id);
      for (const d of existing) {
        await organizationService.deleteDepot(d.id);
      }
      for (let i = 0; i < depots.length; i++) {
        const d = depots[i];
        if (d && d.name) {
          await organizationService.createDepot(id, {
            name: d.name,
            shortName: d.shortName ?? d.short_name,
            displayOrder: d.displayOrder ?? d.display_order ?? i,
          });
        }
      }
    }
    if (Array.isArray(warehouses)) {
      const existing = await organizationService.getWarehousesByOrganizationId(id);
      for (const w of existing) {
        await organizationService.deleteWarehouse(w.id);
      }
      for (const w of warehouses) {
        if (w && w.name) {
          await organizationService.createWarehouse(id, {
            name: w.name,
            shortName: w.shortName ?? w.short_name,
            address: w.address,
            gstNumber: w.gstNumber ?? w.gst_number,
          });
        }
      }
    }

    if (!organization) {
      return res.status(404).json({
        success: false,
        error: 'Organization not found',
      });
    }

    const fullOrg = await organizationService.getOrganizationById(id);
    res.json({
      success: true,
      data: fullOrg ?? organization,
    });
  } catch (error: any) {
    console.error('Error updating organization:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update organization',
    });
  }
}

/**
 * Suspend organization
 */
export async function suspendOrganization(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    await organizationService.suspendOrganization(id);

    res.json({
      success: true,
      message: 'Organization suspended successfully',
    });
  } catch (error: any) {
    console.error('Error suspending organization:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to suspend organization',
    });
  }
}

/**
 * Activate organization
 */
export async function activateOrganization(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    await organizationService.activateOrganization(id);

    res.json({
      success: true,
      message: 'Organization activated successfully',
    });
  } catch (error: any) {
    console.error('Error activating organization:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to activate organization',
    });
  }
}

/**
 * Get organization users
 */
export async function getOrganizationUsers(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const users = await organizationService.getOrganizationUsers(id);

    res.json({
      success: true,
      data: users,
    });
  } catch (error: any) {
    console.error('Error getting organization users:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get organization users',
    });
  }
}

/**
 * Get organization tasks
 */
export async function getOrganizationTasks(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const filters = {
      status: req.query.status as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
    };

    const result = await organizationService.getOrganizationTasks(id, filters);

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('Error getting organization tasks:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get organization tasks',
    });
  }
}

/**
 * Delete organization
 */
export async function deleteOrganization(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    await organizationService.deleteOrganization(id);

    res.json({
      success: true,
      message: 'Organization deleted successfully',
    });
  } catch (error: any) {
    console.error('Error deleting organization:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete organization',
    });
  }
}

/**
 * Get organization statistics
 */
export async function getOrganizationStats(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const stats = await organizationService.getOrganizationStats(id);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error: any) {
    console.error('Error getting organization stats:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get organization statistics',
    });
  }
}

