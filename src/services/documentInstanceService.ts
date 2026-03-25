import { query } from '../config/database';
import { generatePDFFromTemplate, readPDFFile, getPDFFilePath } from './pdfGenerationService';
import { validateFilledData } from './templateService';
import { getDocumentTemplateById } from './documentTemplateService';
import { isS3Key, getObject as s3GetObject, deleteObject as s3DeleteObject, getSignedUrl, resolveToUrl } from './s3StorageService';
import fs from 'fs/promises';
import { getDocumentManagementSettings } from './documentManagementSettingsService';
import { getUserById } from './userService';
import { createNotification } from './notificationService';

export interface DocumentInstance {
  id: string;
  templateId: string;
  organizationId: string;
  title: string;
  filledData: Record<string, any>;
  pdfUrl: string;
  status: 'draft' | 'final' | 'archived';
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentInstanceFilters {
  status?: 'draft' | 'final' | 'archived';
  templateId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

function mapRowToInstance(row: any): DocumentInstance {
  const storedPdfUrl = row.pdf_url;
  const pdfUrl = storedPdfUrl && isS3Key(storedPdfUrl) ? (resolveToUrl(storedPdfUrl) || storedPdfUrl) : storedPdfUrl;
  return {
    id: row.id,
    templateId: row.template_id,
    organizationId: row.organization_id,
    title: row.title,
    filledData: row.filled_data || {},
    pdfUrl: pdfUrl || '',
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Create document instance from template
 */
export async function createDocumentInstance(
  templateId: string,
  filledData: Record<string, any>,
  title: string,
  userId: string,
  organizationId: string,
  userRole: string = 'employee'
): Promise<DocumentInstance> {
  // Apply document approval flow (if enabled by Admin)
  try {
    const settings = await getDocumentManagementSettings(organizationId);
    if (userRole === 'employee' && settings.enabled && settings.checkedByUserId && settings.approvedByUserId) {
      const creator = await getUserById(userId);
      const preparedByName = creator?.name || '';

      filledData = {
        ...(filledData || {}),
        prepared_by: (filledData as any)?.prepared_by ?? preparedByName,
        checked_by: (filledData as any)?.checked_by ?? '',
        approved_by: (filledData as any)?.approved_by ?? '',
        approval_flow: {
          enabled: true,
          stage: 'prepared',
          checkedByUserId: settings.checkedByUserId,
          approvedByUserId: settings.approvedByUserId,
        },
      };
    }
  } catch (e) {
    // Never block document creation due to settings/notification issues
  }

  const computedStatus: 'draft' | 'final' = (filledData as any)?.approval_flow?.enabled ? 'draft' : 'final';

  // Fetch template to validate schema
  const template = await getDocumentTemplateById(templateId);
  if (!template) {
    throw new Error('Template not found');
  }

  if (template.status !== 'active') {
    throw new Error('Template is not active');
  }

  // Validate filled data against template schema
  if (template.templateSchema) {
    const validation = validateFilledData(template.templateSchema, filledData);
    if (!validation.valid) {
      throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
    }
  }

  // PDF: use mobile-provided URL from filledData.meta.pdfUrl if present, else generate server-side
  let pdfUrl: string | null = null;
  const mobilePdfUrl = (filledData as any)?.meta?.pdfUrl;
  if (mobilePdfUrl && typeof mobilePdfUrl === 'string' && mobilePdfUrl.trim()) {
    const url = mobilePdfUrl.trim();
    const keyMatch = url.match(/\/document-pdfs\/[a-zA-Z0-9-]+\.pdf/i);
    pdfUrl = keyMatch ? keyMatch[0].replace(/^\//, '') : url;
  }
  if (pdfUrl === null) {
    try {
      const pdfResult = await generatePDFFromTemplate(templateId, filledData, organizationId);
      pdfUrl = pdfResult.pdfUrl;
    } catch (pdfError: any) {
      if (pdfError.code === 'PDF_GENERATION_UNAVAILABLE') {
        console.warn(`[createDocumentInstance] PDF generation unavailable (missing Chromium dependencies). Document will be created without PDF. PDF can be generated on-demand when downloading.`);
      } else {
        console.warn('[createDocumentInstance] PDF generation failed (document will be created without PDF):', pdfError.message);
      }
    }
  }

  // Create instance record
  const result = await query(
    `INSERT INTO document_instances
      (template_id, organization_id, title, filled_data, pdf_url, status, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [templateId, organizationId, title, JSON.stringify(filledData), pdfUrl, computedStatus, userId]
  );

  // Notify "Checked By" user if approval flow is enabled
  try {
    const flow = (filledData as any)?.approval_flow;
    if (flow?.enabled && flow?.stage === 'prepared' && flow?.checkedByUserId) {
      await createNotification({
        userId: flow.checkedByUserId,
        type: 'document_shared',
        title: `Document pending verification: ${title}`,
        body: 'A new document was prepared and requires your verification.',
        relatedEntityType: 'document_instance',
        relatedEntityId: result.rows[0].id,
      });
    }
  } catch (e) {
    // Ignore notification failures
  }

  return mapRowToInstance(result.rows[0]);
}

/**
 * Get document instances with filters
 */
export async function getDocumentInstances(
  organizationId: string,
  userId: string,
  userRole: string,
  filters: DocumentInstanceFilters = {}
): Promise<{ instances: DocumentInstance[]; total: number; page: number; limit: number; totalPages: number }> {
  const {
    status,
    templateId,
    search,
    page = 1,
    limit = 20,
  } = filters;

  let whereConditions: string[] = [];
  const queryParams: any[] = [];
  let paramIndex = 1;

  // Filter by organization (admins/employees see only their org's documents)
  if (userRole !== 'super_admin') {
    whereConditions.push(`organization_id = $${paramIndex}`);
    queryParams.push(organizationId);
    paramIndex++;
  }

  if (status) {
    whereConditions.push(`status = $${paramIndex}`);
    queryParams.push(status);
    paramIndex++;
  }

  if (templateId) {
    whereConditions.push(`template_id = $${paramIndex}`);
    queryParams.push(templateId);
    paramIndex++;
  }

  if (search) {
    whereConditions.push(`(title ILIKE $${paramIndex} OR filled_data::text ILIKE $${paramIndex})`);
    queryParams.push(`%${search}%`);
    paramIndex++;
  }

  // Exclude archived by default (unless explicitly requested)
  if (!status || status !== 'archived') {
    whereConditions.push(`status != 'archived'`);
  }

  const whereClause = whereConditions.length > 0
    ? `WHERE ${whereConditions.join(' AND ')}`
    : '';

  const offset = (page - 1) * limit;

  // Get total count
  const countResult = await query(
    `SELECT COUNT(*) as total FROM document_instances ${whereClause}`,
    queryParams
  );
  const total = parseInt(countResult.rows[0].total, 10);

  // Get instances
  const result = await query(
    `SELECT * FROM document_instances
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...queryParams, limit, offset]
  );

  return {
    instances: result.rows.map(mapRowToInstance),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get document instance by ID
 */
export async function getDocumentInstanceById(
  id: string,
  userId: string,
  userRole: string,
  organizationId?: string
): Promise<DocumentInstance | null> {
  const result = await query(
    `SELECT * FROM document_instances WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const instance = mapRowToInstance(result.rows[0]);

  // Permission check: users can only access their org's documents (unless super_admin)
  if (userRole !== 'super_admin' && instance.organizationId !== organizationId) {
    return null;
  }

  return instance;
}

/**
 * Update document instance (only if draft)
 */
export async function updateDocumentInstance(
  id: string,
  filledData: Record<string, any>,
  title?: string,
  status?: 'draft' | 'final',
  userId?: string
): Promise<DocumentInstance | null> {
  // Get existing instance
  const existing = await query(
    `SELECT * FROM document_instances WHERE id = $1`,
    [id]
  );

  if (existing.rows.length === 0) {
    return null;
  }

  const instance = mapRowToInstance(existing.rows[0]);

  // Check if data is being changed
  const dataChanged = JSON.stringify(instance.filledData) !== JSON.stringify(filledData);
  
  // Check if only status is being updated (no data changes)
  const isStatusOnlyUpdate = !dataChanged && status !== undefined && status !== instance.status;

  // Allow updates regardless of status (draft, final, etc.) - no status restriction

  // Fetch template for validation (only if data is being changed)
  // Skip validation for Document Builder format (sections/meta) - structure differs from schema
  const isBuilderFormat = filledData && (Array.isArray(filledData.sections) || filledData.meta);
  if (dataChanged && !isBuilderFormat) {
    const template = await getDocumentTemplateById(instance.templateId);
    if (template && template.templateSchema) {
      const validation = validateFilledData(template.templateSchema, filledData);
      if (!validation.valid) {
        throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
      }
    }
  }

  // Determine pdf_url: use mobile-provided URL from filledData.meta.pdfUrl, or regenerate
  let pdfUrl = instance.pdfUrl;

  // If mobile app provided PDF URL in filledData.meta.pdfUrl (from local PDF upload), use it
  const mobilePdfUrl = filledData?.meta?.pdfUrl;
  if (mobilePdfUrl && typeof mobilePdfUrl === 'string' && mobilePdfUrl.trim()) {
    const url = mobilePdfUrl.trim();
    // Extract S3 key from URL for persistence (signed URLs expire; key allows backend to resolve)
    const keyMatch = url.match(/\/document-pdfs\/[a-zA-Z0-9-]+\.pdf/i);
    pdfUrl = keyMatch ? keyMatch[0].replace(/^\//, '') : url;
  } else if (dataChanged) {
    try {
      const pdfResult = await generatePDFFromTemplate(
        instance.templateId,
        filledData,
        instance.organizationId
      );
      pdfUrl = pdfResult.pdfUrl;
    } catch (pdfError: any) {
      if (pdfError.code === 'PDF_GENERATION_UNAVAILABLE') {
        console.warn(`[updateDocumentInstance] PDF regeneration unavailable. Document updated without regenerating PDF.`);
      } else {
        console.warn('[updateDocumentInstance] PDF regeneration failed:', pdfError.message);
      }
    }
  }

  // Build update query
  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  updates.push(`filled_data = $${paramIndex++}`);
  values.push(JSON.stringify(filledData));

  if (title !== undefined) {
    updates.push(`title = $${paramIndex++}`);
    values.push(title);
  }

  if (status !== undefined) {
    updates.push(`status = $${paramIndex++}`);
    values.push(status);
  }

  // Update pdf_url when we have a new value (from mobile meta.pdfUrl or regeneration)
  if (pdfUrl && pdfUrl !== (instance.pdfUrl || '')) {
    updates.push(`pdf_url = $${paramIndex++}`);
    values.push(pdfUrl);
  }

  updates.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  const updatedResult = await query(
    `UPDATE document_instances
    SET ${updates.join(', ')}
    WHERE id = $${paramIndex}
    RETURNING *`,
    values
  );

  if (updatedResult.rows.length === 0) {
    return null;
  }

  return mapRowToInstance(updatedResult.rows[0]);
}

/**
 * Permanently delete document instance and its PDF file
 */
export async function deleteDocumentInstance(
  id: string,
  userId: string,
  userRole: string,
  organizationId?: string
): Promise<boolean> {
  try {
    // Check permissions
    let instance;
    try {
      instance = await getDocumentInstanceById(id, userId, userRole, organizationId);
    } catch (error: any) {
      console.error('Error checking permissions for document instance:', error);
      throw new Error(`Failed to verify document instance access: ${error.message}`);
    }

    if (!instance) {
      console.log(`Document instance ${id} not found or access denied for user ${userId}`);
      return false;
    }

    // Get raw pdf_url (key or path) for file deletion; instance.pdfUrl may be resolved signed URL
    const rawResult = await query(`SELECT pdf_url FROM document_instances WHERE id = $1`, [id]);
    const rawPdfUrl = rawResult.rows[0]?.pdf_url;

    // Delete the database record first
    const result = await query(
      `DELETE FROM document_instances WHERE id = $1`,
      [id]
    );

    if (!result || result.rowCount === null || result.rowCount === 0) {
      console.warn(`Failed to delete document instance ${id} from database - no rows affected`);
      return false;
    }

    // Delete the PDF file from S3 or filesystem
    if (rawPdfUrl) {
      try {
        if (isS3Key(rawPdfUrl)) {
          await s3DeleteObject(rawPdfUrl);
          console.log(`Successfully deleted PDF from S3: ${rawPdfUrl}`);
        } else {
          const pdfPath = getPDFFilePath(rawPdfUrl);
          await fs.unlink(pdfPath);
          console.log(`Successfully deleted PDF file: ${pdfPath}`);
        }
      } catch (fileError: any) {
        if (fileError.code !== 'ENOENT') {
          console.warn(`Warning: Could not delete PDF file:`, fileError.message);
        }
      }
    }

    console.log(`Successfully permanently deleted document instance ${id}`);
    return true;
  } catch (error: any) {
    console.error('Error in deleteDocumentInstance:', {
      error: error.message,
      code: error.code,
      constraint: error.constraint,
      stack: error.stack,
      id,
      userId,
      userRole,
      organizationId,
    });
    
    // Re-throw with more context
    throw error;
  }
}

/**
 * Get signed download URL for document instance (S3 only). Returns null for local files.
 */
export function getDocumentInstanceDownloadUrl(pdfUrl: string, expiresInSeconds?: number): string | null {
  if (!isS3Key(pdfUrl)) return null;
  return getSignedUrl(pdfUrl, expiresInSeconds);
}

/**
 * Get signed download URL for a document instance by ID (after permission check). Returns null if not S3 or not found.
 */
export async function getDocumentInstanceSignedDownloadUrl(
  id: string,
  userId: string,
  userRole: string,
  organizationId?: string,
  expiresInSeconds?: number
): Promise<string | null> {
  const instance = await getDocumentInstanceById(id, userId, userRole, organizationId);
  if (!instance) return null;
  const rawResult = await query(`SELECT pdf_url FROM document_instances WHERE id = $1`, [id]);
  const rawPdfUrl = rawResult.rows[0]?.pdf_url;
  return rawPdfUrl ? getDocumentInstanceDownloadUrl(rawPdfUrl, expiresInSeconds) : null;
}

/**
 * Download document instance PDF as buffer (for streaming response or when signed URL not used).
 * Generates PDF on-demand if it doesn't exist.
 */
export async function downloadDocumentInstance(
  id: string,
  userId: string,
  userRole: string,
  organizationId?: string
): Promise<Buffer | null> {
  const instance = await getDocumentInstanceById(id, userId, userRole, organizationId);
  if (!instance) {
    return null;
  }

  const rawResult = await query(`SELECT pdf_url, template_id, filled_data, organization_id FROM document_instances WHERE id = $1`, [id]);
  const row = rawResult.rows[0];
  let rawPdfUrl = row?.pdf_url;

  // If PDF doesn't exist, generate it on-demand
  if (!rawPdfUrl) {
    try {
      console.log(`[downloadDocumentInstance] PDF not found for instance ${id}, generating on-demand...`);
      const pdfResult = await generatePDFFromTemplate(
        row.template_id,
        typeof row.filled_data === 'string' ? JSON.parse(row.filled_data) : row.filled_data,
        row.organization_id
      );
      rawPdfUrl = pdfResult.pdfUrl;
      
      // Update the instance with the generated PDF URL
      await query(`UPDATE document_instances SET pdf_url = $1 WHERE id = $2`, [rawPdfUrl, id]);
    } catch (pdfError: any) {
      if (pdfError.code === 'PDF_GENERATION_UNAVAILABLE') {
        console.error(`[downloadDocumentInstance] PDF generation unavailable (missing Chromium dependencies). Cannot generate PDF on-demand.`);
      } else {
        console.error('[downloadDocumentInstance] Failed to generate PDF on-demand:', pdfError.message);
      }
      return null;
    }
  }

  if (!rawPdfUrl) return null;

  try {
    if (isS3Key(rawPdfUrl)) {
      return await s3GetObject(rawPdfUrl);
    }
    return await readPDFFile(rawPdfUrl);
  } catch (error) {
    console.error('Error reading PDF file:', error);
    return null;
  }
}

