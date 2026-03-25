import { query } from '../config/database';

export interface DocumentTemplate {
  id: string;
  name: string;
  type: string;
  status: 'active' | 'inactive' | 'draft';
  headerTemplate?: string;
  bodyTemplate: string;
  templateSchema?: Record<string, any>;
  autoFillFields?: Record<string, any>;
  pdfSettings: Record<string, any>;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentTemplateFilters {
  type?: string;
  status?: 'active' | 'inactive' | 'draft';
  search?: string;
  page?: number;
  limit?: number;
}

export interface DocumentTemplateVersion {
  id: string;
  templateId: string;
  version: number;
  bodyTemplate: string;
  pdfSettings: Record<string, any>;
  createdBy: string;
  createdAt: string;
}

/**
 * Get all document templates with filters
 */
export async function getAllDocumentTemplates(filters: DocumentTemplateFilters = {}) {
  const {
    type,
    status,
    search,
    page = 1,
    limit = 20,
  } = filters;

  let whereConditions: string[] = [];
  const queryParams: any[] = [];
  let paramIndex = 1;

  if (type) {
    whereConditions.push(`type = $${paramIndex}`);
    queryParams.push(type);
    paramIndex++;
  }

  if (status) {
    whereConditions.push(`status = $${paramIndex}`);
    queryParams.push(status);
    paramIndex++;
  }

  if (search) {
    whereConditions.push(`name ILIKE $${paramIndex}`);
    queryParams.push(`%${search}%`);
    paramIndex++;
  }

  const whereClause = whereConditions.length > 0
    ? `WHERE ${whereConditions.join(' AND ')}`
    : '';

  const offset = (page - 1) * limit;

  // Get total count
  const countResult = await query(
    `SELECT COUNT(*) as total FROM document_templates ${whereClause}`,
    queryParams
  );
  const total = parseInt(countResult.rows[0].total, 10);

  // Get templates
  const result = await query(
    `SELECT 
      id, name, type, status, header_template, body_template, template_schema, auto_fill_fields, pdf_settings, version, 
      created_by, created_at, updated_at
    FROM document_templates 
    ${whereClause}
    ORDER BY updated_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...queryParams, limit, offset]
  );

  return {
    templates: result.rows.map(mapTemplate),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get document template by ID
 */
export async function getDocumentTemplateById(id: string): Promise<DocumentTemplate | null> {
  const result = await query(
    `SELECT 
      id, name, type, status, header_template, body_template, template_schema, auto_fill_fields, pdf_settings, version, 
      created_by, created_at, updated_at
    FROM document_templates 
    WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return mapTemplate(result.rows[0]);
}

/**
 * Get template for user (with schema for editing)
 */
export async function getTemplateForUser(templateId: string, userId: string): Promise<DocumentTemplate | null> {
  // For now, same as getDocumentTemplateById, but can add user-specific logic later
  return getDocumentTemplateById(templateId);
}

/**
 * Get active templates for organization
 */
export async function getActiveTemplatesForOrganization(organizationId: string): Promise<DocumentTemplate[]> {
  const result = await query(
    `SELECT 
      id, name, type, status, header_template, body_template, template_schema, auto_fill_fields, pdf_settings, version, 
      created_by, created_at, updated_at
    FROM document_templates 
    WHERE status = 'active'
    ORDER BY name ASC`,
    []
  );

  return result.rows.map(mapTemplate);
}

/**
 * Create document template
 */
export async function createDocumentTemplate(data: {
  name: string;
  type: string;
  status?: 'active' | 'inactive' | 'draft';
  headerTemplate?: string;
  bodyTemplate: string;
  templateSchema?: Record<string, any>;
  autoFillFields?: Record<string, any>;
  pdfSettings?: Record<string, any>;
  createdBy: string;
}): Promise<DocumentTemplate> {
  const result = await query(
    `INSERT INTO document_templates 
    (name, type, status, header_template, body_template, template_schema, auto_fill_fields, pdf_settings, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id, name, type, status, header_template, body_template, template_schema, auto_fill_fields, pdf_settings, version, 
      created_by, created_at, updated_at`,
    [
      data.name,
      data.type,
      data.status || 'draft',
      data.headerTemplate || null,
      data.bodyTemplate,
      JSON.stringify(data.templateSchema || {}),
      JSON.stringify(data.autoFillFields || {}),
      JSON.stringify(data.pdfSettings || {}),
      data.createdBy,
    ]
  );

  const template = mapTemplate(result.rows[0]);

  // Create initial version
  await query(
    `INSERT INTO document_template_versions 
    (template_id, version, body_template, pdf_settings, created_by)
    VALUES ($1, $2, $3, $4, $5)`,
    [
      template.id,
      1,
      data.bodyTemplate,
      JSON.stringify(data.pdfSettings || {}),
      data.createdBy,
    ]
  );

  return template;
}

/**
 * Update document template
 */
export async function updateDocumentTemplate(
  id: string,
  data: Partial<{
    name: string;
    type: string;
    status: 'active' | 'inactive' | 'draft';
    headerTemplate: string;
    bodyTemplate: string;
    templateSchema: Record<string, any>;
    autoFillFields: Record<string, any>;
    pdfSettings: Record<string, any>;
  }>,
  updatedBy: string
): Promise<DocumentTemplate | null> {
  // Get current template
  const current = await getDocumentTemplateById(id);
  if (!current) {
    return null;
  }

  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.type !== undefined) {
    updates.push(`type = $${paramIndex++}`);
    values.push(data.type);
  }
  if (data.status !== undefined) {
    updates.push(`status = $${paramIndex++}`);
    values.push(data.status);
  }
  if (data.headerTemplate !== undefined) {
    updates.push(`header_template = $${paramIndex++}`);
    values.push(data.headerTemplate);
  }
  if (data.bodyTemplate !== undefined) {
    updates.push(`body_template = $${paramIndex++}`);
    values.push(data.bodyTemplate);
    // Increment version if body template changed
    updates.push(`version = version + 1`);
  }
  if (data.templateSchema !== undefined) {
    updates.push(`template_schema = $${paramIndex++}`);
    values.push(JSON.stringify(data.templateSchema));
  }
  if (data.autoFillFields !== undefined) {
    updates.push(`auto_fill_fields = $${paramIndex++}`);
    values.push(JSON.stringify(data.autoFillFields));
  }
  if (data.pdfSettings !== undefined) {
    updates.push(`pdf_settings = $${paramIndex++}`);
    values.push(JSON.stringify(data.pdfSettings));
  }

  if (updates.length === 0) {
    return current;
  }

  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  const result = await query(
    `UPDATE document_templates 
    SET ${updates.join(', ')}
    WHERE id = $${paramIndex}
    RETURNING id, name, type, status, header_template, body_template, template_schema, auto_fill_fields, pdf_settings, version, 
      created_by, created_at, updated_at`,
    values
  );

  if (result.rows.length === 0) {
    return null;
  }

  const updated = mapTemplate(result.rows[0]);

  // If body template changed, create new version
  if (data.bodyTemplate !== undefined) {
    await query(
      `INSERT INTO document_template_versions 
      (template_id, version, body_template, pdf_settings, created_by)
      VALUES ($1, $2, $3, $4, $5)`,
      [
        updated.id,
        updated.version,
        updated.bodyTemplate,
        JSON.stringify(updated.pdfSettings),
        updatedBy,
      ]
    );
  }

  return updated;
}

/**
 * Delete document template
 */
export async function deleteDocumentTemplate(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM document_templates WHERE id = $1`,
    [id]
  );

  return result.rowCount > 0;
}

/**
 * Get template version history
 */
export async function getTemplateVersions(templateId: string): Promise<DocumentTemplateVersion[]> {
  const result = await query(
    `SELECT 
      id, template_id, version, body_template, pdf_settings, created_by, created_at
    FROM document_template_versions
    WHERE template_id = $1
    ORDER BY version DESC`,
    [templateId]
  );

  return result.rows.map(row => ({
    id: row.id,
    templateId: row.template_id,
    version: row.version,
    bodyTemplate: row.body_template,
    pdfSettings: row.pdf_settings || {},
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  }));
}

/**
 * Map database row to DocumentTemplate
 */
function mapTemplate(row: any): DocumentTemplate {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    status: row.status,
    headerTemplate: row.header_template || undefined,
    bodyTemplate: row.body_template,
    templateSchema: row.template_schema || undefined,
    autoFillFields: row.auto_fill_fields || undefined,
    pdfSettings: row.pdf_settings || {},
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

