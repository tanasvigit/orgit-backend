import { query } from '../config/database';
import { ComplianceMaster } from '../../shared/src/types';
import { canEditCompliance, checkOrganizationAccess } from '../middleware/adminMiddleware';

export interface ComplianceFilters {
  category?: string;
  status?: 'ACTIVE' | 'INACTIVE';
  scope?: 'GLOBAL' | 'ORG';
  search?: string;
  page?: number;
  limit?: number;
}

export interface CreateComplianceData {
  title: string;
  category: string;
  actName?: string;
  description?: string;
  complianceType: 'ONE_TIME' | 'RECURRING';
  frequency?: 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'YEARLY';
  effectiveDate?: string;
  status?: 'ACTIVE' | 'INACTIVE';
  version?: string;
  // Extended compliance metadata fields
  complianceCode?: string;
  applicableLaw?: string;
  sectionRuleReference?: string;
  governingAuthority?: string;
  jurisdictionType?: string;
  stateApplicability?: string;
  industryApplicability?: string;
  entityTypeApplicability?: string;
  applicabilityThreshold?: string;
  mandatoryFlag?: boolean;
  riskLevel?: string;
  penaltySummary?: string;
  maxPenaltyAmount?: number;
  imprisonmentFlag?: boolean;
  complianceFrequency?: string;
  dueDateType?: string;
  dueDate?: string;
  dueDateRule?: string;
  gracePeriodDays?: number;
  financialYearApplicable?: boolean;
  firstTimeCompliance?: boolean;
    triggerEvent?: string;
    approvalStatus?: string;
    approvedBy?: string;
    scope?: 'GLOBAL' | 'ORG';
    organizationId?: string | null;
}

/**
 * Get compliances for a user based on their role and organization
 * - Super Admin: sees all GLOBAL + all ORG compliances
 * - Admin: sees all GLOBAL + own ORG compliances
 */
export async function getComplianceForUser(
  userId: string,
  userRole: string,
  userOrganizationId: string | null | undefined,
  filters: ComplianceFilters = {}
) {
  const {
    category,
    status,
    scope,
    search,
    page = 1,
    limit = 20,
  } = filters;

  let whereConditions: string[] = [];
  const queryParams: any[] = [];
  let paramIndex = 1;

  // Scope-based filtering
  if (userRole === 'super_admin') {
    // Super Admin sees everything - no scope filter needed
  } else if (userRole === 'admin') {
    // Admin sees GLOBAL + own ORG compliances
    whereConditions.push(
      `(scope = 'GLOBAL' OR (scope = 'ORG' AND organization_id = $${paramIndex}))`
    );
    queryParams.push(userOrganizationId);
    paramIndex++;
  } else {
    // Employee sees GLOBAL + own ORG compliances (read-only)
    whereConditions.push(
      `(scope = 'GLOBAL' OR (scope = 'ORG' AND organization_id = $${paramIndex}))`
    );
    queryParams.push(userOrganizationId);
    paramIndex++;
  }

  if (category) {
    whereConditions.push(`category = $${paramIndex++}`);
    queryParams.push(category);
  }

  if (status) {
    whereConditions.push(`status = $${paramIndex++}`);
    queryParams.push(status);
  }

  if (scope) {
    whereConditions.push(`scope = $${paramIndex++}`);
    queryParams.push(scope);
  }

  if (search) {
    whereConditions.push(
      `(title ILIKE $${paramIndex} OR description ILIKE $${paramIndex} OR act_name ILIKE $${paramIndex})`
    );
    queryParams.push(`%${search}%`);
    paramIndex++;
  }

  const whereClause = whereConditions.length > 0
    ? `WHERE ${whereConditions.join(' AND ')}`
    : '';

  const offset = (page - 1) * limit;

  // Get total count
  const countResult = await query(
    `SELECT COUNT(*) as total FROM compliance_master ${whereClause}`,
    queryParams
  );
  const total = parseInt(countResult.rows[0].total, 10);

  // Get compliances
  const result = await query(
    `SELECT 
      id, title, category, act_name, description, compliance_type, frequency,
      effective_date, status, scope, organization_id, version,
      compliance_code, applicable_law, section_rule_reference, governing_authority,
      jurisdiction_type, state_applicability, industry_applicability, entity_type_applicability,
      applicability_threshold, mandatory_flag, risk_level, penalty_summary, max_penalty_amount,
      imprisonment_flag, compliance_frequency, due_date_type, due_date, due_date_rule,
      grace_period_days, financial_year_applicable, first_time_compliance, trigger_event,
      approval_status, approved_by,
      created_by, created_by_role, created_at, updated_at
    FROM compliance_master 
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...queryParams, limit, offset]
  );

  return {
    items: result.rows.map(mapComplianceMaster),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get compliance by ID with permission check
 */
export async function getComplianceById(
  id: string,
  userId: string,
  userRole: string,
  userOrganizationId: string | null | undefined
): Promise<ComplianceMaster | null> {
  const result = await query(
    `SELECT 
      id, title, category, act_name, description, compliance_type, frequency,
      effective_date, status, scope, organization_id, version,
      compliance_code, applicable_law, section_rule_reference, governing_authority,
      jurisdiction_type, state_applicability, industry_applicability, entity_type_applicability,
      applicability_threshold, mandatory_flag, risk_level, penalty_summary, max_penalty_amount,
      imprisonment_flag, compliance_frequency, due_date_type, due_date, due_date_rule,
      grace_period_days, financial_year_applicable, first_time_compliance, trigger_event,
      approval_status, approved_by,
      created_by, created_by_role, created_at, updated_at
    FROM compliance_master 
    WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const compliance = mapComplianceMaster(result.rows[0]);

  // Check visibility permission
  const hasAccess = await checkOrganizationAccess(
    userId,
    userRole,
    compliance.organizationId || null
  );

  if (!hasAccess) {
    // If Super Admin, they can access everything
    if (userRole === 'super_admin') {
      return compliance;
    }
    // Otherwise, check if it's GLOBAL or user's org
    if (compliance.scope === 'GLOBAL') {
      return compliance;
    }
    if (compliance.scope === 'ORG' && compliance.organizationId === userOrganizationId) {
      return compliance;
    }
    return null; // No access
  }

  return compliance;
}

/**
 * Create compliance with role-based scope assignment
 */
export async function createCompliance(
  data: CreateComplianceData,
  userId: string,
  userRole: string,
  userOrganizationId: string | null | undefined
): Promise<ComplianceMaster> {
  // Determine scope based on role
  let scope: 'GLOBAL' | 'ORG';
  let organizationId: string | null = null;

  if (userRole === 'super_admin') {
    scope = 'GLOBAL';
    organizationId = null;
  } else if (userRole === 'admin') {
    scope = 'ORG';
    if (!userOrganizationId) {
      throw new Error('Admin must be associated with an organization');
    }
    organizationId = userOrganizationId;
  } else {
    throw new Error('Only Super Admin and Admin can create compliances');
  }

  // Check for duplicate title within same scope
  const duplicateCheck = await query(
    `SELECT id FROM compliance_master 
     WHERE title = $1 AND scope = $2 AND (organization_id = $3 OR (organization_id IS NULL AND $3 IS NULL))`,
    [data.title, scope, organizationId]
  );

  if (duplicateCheck.rows.length > 0) {
    throw new Error(`A compliance with title "${data.title}" already exists in this scope`);
  }

  // Determine created_by_role
  const createdByRole = userRole === 'super_admin' ? 'SUPER_ADMIN' : 'ADMIN';

  // Validate frequency field
  let frequency: 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'YEARLY' | null = null;
  if (data.complianceType === 'RECURRING' && data.frequency) {
    const validFrequencies = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'];
    if (validFrequencies.includes(data.frequency)) {
      frequency = data.frequency;
    } else {
      throw new Error(`Invalid frequency value: ${data.frequency}. Must be one of: MONTHLY, QUARTERLY, HALF_YEARLY, YEARLY`);
    }
  } else if (data.complianceType === 'ONE_TIME') {
    // ONE_TIME compliances should not have frequency
    frequency = null;
  }

  const result = await query(
    `INSERT INTO compliance_master 
    (title, category, act_name, description, compliance_type, frequency, 
     effective_date, status, scope, organization_id, version,
     compliance_code, applicable_law, section_rule_reference, governing_authority,
     jurisdiction_type, state_applicability, industry_applicability, entity_type_applicability,
     applicability_threshold, mandatory_flag, risk_level, penalty_summary, max_penalty_amount,
     imprisonment_flag, compliance_frequency, due_date_type, due_date, due_date_rule,
     grace_period_days, financial_year_applicable, first_time_compliance, trigger_event,
     approval_status, approved_by,
     created_by, created_by_role)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37)
    RETURNING id, title, category, act_name, description, compliance_type, frequency,
      effective_date, status, scope, organization_id, version,
      compliance_code, applicable_law, section_rule_reference, governing_authority,
      jurisdiction_type, state_applicability, industry_applicability, entity_type_applicability,
      applicability_threshold, mandatory_flag, risk_level, penalty_summary, max_penalty_amount,
      imprisonment_flag, compliance_frequency, due_date_type, due_date, due_date_rule,
      grace_period_days, financial_year_applicable, first_time_compliance, trigger_event,
      approval_status, approved_by,
      created_by, created_by_role, created_at, updated_at`,
    [
      data.title,
      data.category,
      data.actName || null,
      data.description || null,
      data.complianceType,
      frequency, // Use validated frequency
      data.effectiveDate || null,
      data.status || 'ACTIVE',
      scope,
      organizationId,
      data.version || '1.0',
      data.complianceCode || null,
      data.applicableLaw || null,
      data.sectionRuleReference || null,
      data.governingAuthority || null,
      data.jurisdictionType || null,
      data.stateApplicability || null,
      data.industryApplicability || null,
      data.entityTypeApplicability || null,
      data.applicabilityThreshold || null,
      data.mandatoryFlag ?? null,
      data.riskLevel || null,
      data.penaltySummary || null,
      data.maxPenaltyAmount ?? null,
      data.imprisonmentFlag ?? null,
      data.complianceFrequency || null,
      data.dueDateType || null,
      data.dueDate || null,
      data.dueDateRule || null,
      data.gracePeriodDays ?? null,
      data.financialYearApplicable ?? null,
      data.firstTimeCompliance ?? null,
      data.triggerEvent || null,
      data.approvalStatus || null,
      data.approvedBy || null,
      userId,
      createdByRole,
    ]
  );

  return mapComplianceMaster(result.rows[0]);
}

/**
 * Update compliance with permission check
 */
export async function updateCompliance(
  id: string,
  data: Partial<CreateComplianceData>,
  userId: string,
  userRole: string,
  userOrganizationId: string | null | undefined
): Promise<ComplianceMaster | null> {
  // First, get the existing compliance
  const existing = await getComplianceById(id, userId, userRole, userOrganizationId);
  if (!existing) {
    return null;
  }

  // Check edit permission
  const canEdit = await canEditCompliance(
    userId,
    userRole,
    existing.scope,
    existing.organizationId || null
  );

  if (!canEdit) {
    throw new Error('You do not have permission to edit this compliance');
  }

  // Prevent scope change by Admin (but Super Admin can change scope when approving)
  if (data.scope && existing.scope === 'GLOBAL' && userRole === 'admin') {
    throw new Error('Admin cannot modify Global compliances');
  }
  
  // Super Admin can change scope when approving (ORG -> GLOBAL)
  if (data.scope === 'GLOBAL' && existing.scope === 'ORG' && userRole === 'super_admin') {
    // Allow scope change - this is approval action
    // organizationId will be set to null when making GLOBAL
  } else if (data.scope && data.scope !== existing.scope && userRole !== 'super_admin') {
    throw new Error('Only Super Admin can change compliance scope');
  }

  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (data.title !== undefined) {
    // Check for duplicate title within same scope
    const duplicateCheck = await query(
      `SELECT id FROM compliance_master 
       WHERE title = $1 AND scope = $2 AND (organization_id = $3 OR (organization_id IS NULL AND $3 IS NULL)) AND id != $4`,
      [data.title, existing.scope, existing.organizationId, id]
    );
    if (duplicateCheck.rows.length > 0) {
      throw new Error(`A compliance with title "${data.title}" already exists in this scope`);
    }
    updates.push(`title = $${paramIndex++}`);
    values.push(data.title);
  }
  if (data.category !== undefined) {
    updates.push(`category = $${paramIndex++}`);
    values.push(data.category);
  }
  if (data.actName !== undefined) {
    updates.push(`act_name = $${paramIndex++}`);
    values.push(data.actName);
  }
  if (data.description !== undefined) {
    updates.push(`description = $${paramIndex++}`);
    values.push(data.description);
  }
  if (data.complianceType !== undefined) {
    updates.push(`compliance_type = $${paramIndex++}`);
    values.push(data.complianceType);
  }
  if (data.frequency !== undefined) {
    // Validate frequency field
    let frequency: 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'YEARLY' | null = null;
    // Get current compliance type to validate frequency
    const currentCompliance = await query(
      `SELECT compliance_type FROM compliance_master WHERE id = $1`,
      [id]
    );
    const complianceType = currentCompliance.rows[0]?.compliance_type || data.complianceType;
    
    if (complianceType === 'RECURRING' && data.frequency) {
      const validFrequencies = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'];
      if (validFrequencies.includes(data.frequency)) {
        frequency = data.frequency;
      } else {
        throw new Error(`Invalid frequency value: ${data.frequency}. Must be one of: MONTHLY, QUARTERLY, HALF_YEARLY, YEARLY`);
      }
    } else if (complianceType === 'ONE_TIME') {
      frequency = null;
    }
    updates.push(`frequency = $${paramIndex++}`);
    values.push(frequency);
  }
  if (data.effectiveDate !== undefined) {
    updates.push(`effective_date = $${paramIndex++}`);
    values.push(data.effectiveDate || null);
  }
  if (data.status !== undefined) {
    updates.push(`status = $${paramIndex++}`);
    values.push(data.status);
  }
  if (data.version !== undefined) {
    updates.push(`version = $${paramIndex++}`);
    values.push(data.version);
  }
  // Extended fields
  if (data.complianceCode !== undefined) {
    updates.push(`compliance_code = $${paramIndex++}`);
    values.push(data.complianceCode || null);
  }
  if (data.applicableLaw !== undefined) {
    updates.push(`applicable_law = $${paramIndex++}`);
    values.push(data.applicableLaw || null);
  }
  if (data.sectionRuleReference !== undefined) {
    updates.push(`section_rule_reference = $${paramIndex++}`);
    values.push(data.sectionRuleReference || null);
  }
  if (data.governingAuthority !== undefined) {
    updates.push(`governing_authority = $${paramIndex++}`);
    values.push(data.governingAuthority || null);
  }
  if (data.jurisdictionType !== undefined) {
    updates.push(`jurisdiction_type = $${paramIndex++}`);
    values.push(data.jurisdictionType || null);
  }
  if (data.stateApplicability !== undefined) {
    updates.push(`state_applicability = $${paramIndex++}`);
    values.push(data.stateApplicability || null);
  }
  if (data.industryApplicability !== undefined) {
    updates.push(`industry_applicability = $${paramIndex++}`);
    values.push(data.industryApplicability || null);
  }
  if (data.entityTypeApplicability !== undefined) {
    updates.push(`entity_type_applicability = $${paramIndex++}`);
    values.push(data.entityTypeApplicability || null);
  }
  if (data.applicabilityThreshold !== undefined) {
    updates.push(`applicability_threshold = $${paramIndex++}`);
    values.push(data.applicabilityThreshold || null);
  }
  if (data.mandatoryFlag !== undefined) {
    updates.push(`mandatory_flag = $${paramIndex++}`);
    values.push(data.mandatoryFlag ?? null);
  }
  if (data.riskLevel !== undefined) {
    updates.push(`risk_level = $${paramIndex++}`);
    values.push(data.riskLevel || null);
  }
  if (data.penaltySummary !== undefined) {
    updates.push(`penalty_summary = $${paramIndex++}`);
    values.push(data.penaltySummary || null);
  }
  if (data.maxPenaltyAmount !== undefined) {
    updates.push(`max_penalty_amount = $${paramIndex++}`);
    values.push(data.maxPenaltyAmount ?? null);
  }
  if (data.imprisonmentFlag !== undefined) {
    updates.push(`imprisonment_flag = $${paramIndex++}`);
    values.push(data.imprisonmentFlag ?? null);
  }
  if (data.complianceFrequency !== undefined) {
    updates.push(`compliance_frequency = $${paramIndex++}`);
    values.push(data.complianceFrequency || null);
  }
  if (data.dueDateType !== undefined) {
    updates.push(`due_date_type = $${paramIndex++}`);
    values.push(data.dueDateType || null);
  }
  if (data.dueDate !== undefined) {
    updates.push(`due_date = $${paramIndex++}`);
    values.push(data.dueDate || null);
  }
  if (data.dueDateRule !== undefined) {
    updates.push(`due_date_rule = $${paramIndex++}`);
    values.push(data.dueDateRule || null);
  }
  if (data.gracePeriodDays !== undefined) {
    updates.push(`grace_period_days = $${paramIndex++}`);
    values.push(data.gracePeriodDays ?? null);
  }
  if (data.financialYearApplicable !== undefined) {
    updates.push(`financial_year_applicable = $${paramIndex++}`);
    values.push(data.financialYearApplicable ?? null);
  }
  if (data.firstTimeCompliance !== undefined) {
    updates.push(`first_time_compliance = $${paramIndex++}`);
    values.push(data.firstTimeCompliance ?? null);
  }
  if (data.triggerEvent !== undefined) {
    updates.push(`trigger_event = $${paramIndex++}`);
    values.push(data.triggerEvent || null);
  }
  if (data.approvalStatus !== undefined) {
    updates.push(`approval_status = $${paramIndex++}`);
    values.push(data.approvalStatus || null);
  }
  if (data.approvedBy !== undefined) {
    updates.push(`approved_by = $${paramIndex++}`);
    values.push(data.approvedBy || null);
  }
  if (data.scope !== undefined) {
    // Super Admin can change scope when approving (ORG -> GLOBAL)
    if (data.scope === 'GLOBAL' && existing.scope === 'ORG' && userRole === 'super_admin') {
      updates.push(`scope = $${paramIndex++}`);
      values.push(data.scope);
      // When changing to GLOBAL, remove organization association
      updates.push(`organization_id = NULL`);
    } else if (data.scope !== existing.scope && userRole !== 'super_admin') {
      throw new Error('Only Super Admin can change compliance scope');
    } else if (data.scope !== existing.scope) {
      updates.push(`scope = $${paramIndex++}`);
      values.push(data.scope);
      // If changing to GLOBAL, also set organization_id to NULL
      if (data.scope === 'GLOBAL') {
        updates.push(`organization_id = NULL`);
      }
    }
  }
  if (data.organizationId !== undefined && data.scope !== 'GLOBAL' && (!data.scope || data.scope === 'ORG')) {
    // Only update organizationId if scope is ORG
    updates.push(`organization_id = $${paramIndex++}`);
    values.push(data.organizationId || null);
  }

  if (updates.length === 0) {
    return existing;
  }

  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  const result = await query(
    `UPDATE compliance_master 
    SET ${updates.join(', ')}
    WHERE id = $${paramIndex}
    RETURNING id, title, category, act_name, description, compliance_type, frequency,
      effective_date, status, scope, organization_id, version,
      compliance_code, applicable_law, section_rule_reference, governing_authority,
      jurisdiction_type, state_applicability, industry_applicability, entity_type_applicability,
      applicability_threshold, mandatory_flag, risk_level, penalty_summary, max_penalty_amount,
      imprisonment_flag, compliance_frequency, due_date_type, due_date, due_date_rule,
      grace_period_days, financial_year_applicable, first_time_compliance, trigger_event,
      approval_status, approved_by,
      created_by, created_by_role, created_at, updated_at`,
    values
  );

  if (result.rows.length === 0) {
    return null;
  }

  return mapComplianceMaster(result.rows[0]);
}

/**
 * Update compliance status (activate/deactivate)
 */
export async function updateComplianceStatus(
  id: string,
  status: 'ACTIVE' | 'INACTIVE',
  userId: string,
  userRole: string,
  userOrganizationId: string | null | undefined
): Promise<ComplianceMaster | null> {
  return updateCompliance(id, { status }, userId, userRole, userOrganizationId);
}

/**
 * Delete compliance
 */
export async function deleteCompliance(
  id: string,
  userId: string,
  userRole: string,
  userOrganizationId: string | null | undefined
): Promise<boolean> {
  // Check permission first
  const existing = await getComplianceById(id, userId, userRole, userOrganizationId);
  if (!existing) {
    return false;
  }

  const canEdit = await canEditCompliance(
    userId,
    userRole,
    existing.scope,
    existing.organizationId || null
  );

  if (!canEdit) {
    throw new Error('You do not have permission to delete this compliance');
  }

  const result = await query(
    `DELETE FROM compliance_master WHERE id = $1`,
    [id]
  );

  return result.rowCount > 0;
}

/**
 * Get compliance categories
 */
export async function getComplianceCategories(): Promise<string[]> {
  const result = await query(
    `SELECT DISTINCT category FROM compliance_master ORDER BY category`,
    []
  );

  return result.rows.map(row => row.category);
}

/**
 * Check if user can edit compliance
 */
export async function canUserEditCompliance(
  complianceId: string,
  userId: string,
  userRole: string,
  userOrganizationId: string | null | undefined
): Promise<boolean> {
  const compliance = await getComplianceById(id, userId, userRole, userOrganizationId);
  if (!compliance) {
    return false;
  }

  return canEditCompliance(
    userId,
    userRole,
    compliance.scope,
    compliance.organizationId || null
  );
}

/**
 * Map database row to ComplianceMaster
 */
function mapComplianceMaster(row: any): ComplianceMaster {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    actName: row.act_name,
    description: row.description,
    complianceType: row.compliance_type,
    frequency: row.frequency,
    effectiveDate: row.effective_date ? row.effective_date.toISOString().split('T')[0] : undefined,
    status: row.status,
    scope: row.scope,
    organizationId: row.organization_id,
    version: row.version,
    // Extended fields
    complianceCode: row.compliance_code,
    applicableLaw: row.applicable_law,
    sectionRuleReference: row.section_rule_reference,
    governingAuthority: row.governing_authority,
    jurisdictionType: row.jurisdiction_type,
    stateApplicability: row.state_applicability,
    industryApplicability: row.industry_applicability,
    entityTypeApplicability: row.entity_type_applicability,
    applicabilityThreshold: row.applicability_threshold,
    mandatoryFlag: row.mandatory_flag ?? undefined,
    riskLevel: row.risk_level,
    penaltySummary: row.penalty_summary,
    maxPenaltyAmount: row.max_penalty_amount ? parseFloat(row.max_penalty_amount) : undefined,
    imprisonmentFlag: row.imprisonment_flag ?? undefined,
    complianceFrequency: row.compliance_frequency,
    dueDateType: row.due_date_type,
    dueDate: row.due_date ? row.due_date.toISOString().split('T')[0] : undefined,
    dueDateRule: row.due_date_rule,
    gracePeriodDays: row.grace_period_days ?? undefined,
    financialYearApplicable: row.financial_year_applicable ?? undefined,
    firstTimeCompliance: row.first_time_compliance ?? undefined,
    triggerEvent: row.trigger_event,
    approvalStatus: row.approval_status,
    approvedBy: row.approved_by,
    createdBy: row.created_by,
    createdByRole: row.created_by_role,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
