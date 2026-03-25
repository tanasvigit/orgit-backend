import { query } from '../config/database';
import { getDocumentTemplateById } from './documentTemplateService';
import { isS3Key, getObject as s3GetObject, getSignedUrl, resolveToUrl } from './s3StorageService';
import { readPDFFile } from './pdfGenerationService';

export interface UserDocument {
  id: string;
  templateId: string;
  templateName?: string;
  organizationId: string;
  title: string;
  pdfUrl: string;
  createdBy: string;
  createdAt: string;
}

export interface UserDocumentFilters {
  templateId?: string;
  search?: string;
  page?: number;
  limit?: number;
}

function normalizePdfUrlForStorage(url: string): string {
  const trimmed = (url || '').trim();
  if (!trimmed) return trimmed;
  const keyMatch = trimmed.match(/\/document-pdfs\/[a-zA-Z0-9-]+\.pdf/i);
  if (keyMatch) return keyMatch[0].replace(/^\//, '');
  return trimmed;
}

function resolvePdfUrl(stored: string | null | undefined): string {
  if (!stored) return '';
  if (isS3Key(stored)) return getSignedUrl(stored) || stored;
  if (stored.startsWith('http')) return stored;
  return resolveToUrl(stored) || stored;
}

function mapRowToUserDocument(row: any): UserDocument {
  return {
    id: row.id,
    templateId: row.template_id,
    templateName: row.template_name,
    organizationId: row.organization_id,
    title: row.title,
    pdfUrl: resolvePdfUrl(row.pdf_url),
    createdBy: row.created_by,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
  };
}

export async function createUserDocument(params: {
  templateId: string;
  organizationId: string;
  title: string;
  pdfUrl: string;
  userId: string;
}): Promise<UserDocument> {
  const { templateId, organizationId, title, pdfUrl, userId } = params;
  const template = await getDocumentTemplateById(templateId);
  if (!template) throw new Error('Template not found');
  if (template.status !== 'active') throw new Error('Template is not active');

  const storedPdfUrl = normalizePdfUrlForStorage(pdfUrl);
  if (!storedPdfUrl) throw new Error('pdfUrl is required');

  const result = await query(
    `INSERT INTO user_documents (template_id, organization_id, title, pdf_url, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [templateId, organizationId, title, storedPdfUrl, userId]
  );
  const row = result.rows[0];
  return mapRowToUserDocument(row);
}

export async function getUserDocumentsForUser(
  organizationId: string,
  filters: UserDocumentFilters = {}
): Promise<{ documents: UserDocument[]; total: number; page: number; limit: number; totalPages: number }> {
  const { templateId, search, page = 1, limit = 20 } = filters;
  const whereConditions: string[] = ['ud.organization_id = $1'];
  const queryParams: any[] = [organizationId];
  let paramIndex = 2;

  if (templateId) {
    whereConditions.push(`ud.template_id = $${paramIndex++}`);
    queryParams.push(templateId);
  }
  if (search && search.trim()) {
    whereConditions.push(`(ud.title ILIKE $${paramIndex} OR dt.name ILIKE $${paramIndex})`);
    queryParams.push(`%${search.trim()}%`);
    paramIndex++;
  }

  const whereClause = whereConditions.join(' AND ');
  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM user_documents ud
     LEFT JOIN document_templates dt ON dt.id = ud.template_id
     WHERE ${whereClause}`,
    queryParams
  );
  const total = countResult.rows[0]?.total ?? 0;
  const offset = (page - 1) * limit;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const listResult = await query(
    `SELECT ud.id, ud.template_id, ud.organization_id, ud.title, ud.pdf_url, ud.created_by, ud.created_at,
            dt.name AS template_name
     FROM user_documents ud
     LEFT JOIN document_templates dt ON dt.id = ud.template_id
     WHERE ${whereClause}
     ORDER BY ud.created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...queryParams, limit, offset]
  );

  const documents = listResult.rows.map((r: any) => ({
    ...mapRowToUserDocument(r),
    templateName: r.template_name,
  }));

  return { documents, total, page, limit, totalPages };
}

export async function getUserDocumentById(
  id: string,
  organizationId: string
): Promise<UserDocument | null> {
  const result = await query(
    `SELECT ud.id, ud.template_id, ud.organization_id, ud.title, ud.pdf_url, ud.created_by, ud.created_at,
            dt.name AS template_name
     FROM user_documents ud
     LEFT JOIN document_templates dt ON dt.id = ud.template_id
     WHERE ud.id = $1 AND ud.organization_id = $2`,
    [id, organizationId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { ...mapRowToUserDocument(row), templateName: row.template_name };
}

export function getUserDocumentDownloadUrl(
  pdfUrlStored: string,
  expiresInSeconds?: number
): string | null {
  if (!pdfUrlStored?.trim()) return null;
  if (isS3Key(pdfUrlStored)) return getSignedUrl(pdfUrlStored, expiresInSeconds);
  if (pdfUrlStored.startsWith('http')) return pdfUrlStored;
  return resolveToUrl(pdfUrlStored) || pdfUrlStored;
}

export async function downloadUserDocument(
  id: string,
  organizationId: string
): Promise<Buffer | null> {
  const result = await query(
    `SELECT pdf_url FROM user_documents WHERE id = $1 AND organization_id = $2`,
    [id, organizationId]
  );
  if (result.rows.length === 0) return null;
  const rawPdfUrl = result.rows[0].pdf_url;
  if (!rawPdfUrl) return null;

  try {
    if (isS3Key(rawPdfUrl)) return await s3GetObject(rawPdfUrl);
    return await readPDFFile(rawPdfUrl);
  } catch (error) {
    console.error('[downloadUserDocument] Error reading PDF:', error);
    return null;
  }
}

export async function deleteUserDocument(
  id: string,
  organizationId: string
): Promise<boolean> {
  const result = await query(
    `DELETE FROM user_documents WHERE id = $1 AND organization_id = $2`,
    [id, organizationId]
  );
  return (result.rowCount ?? 0) > 0;
}
