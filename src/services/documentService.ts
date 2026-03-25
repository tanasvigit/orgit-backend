import { query } from '../config/database';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { Document, User } from '../../shared/src/types';
import { isConfigured as isS3Configured, upload as s3Upload, resolveToUrl, isS3Key } from './s3StorageService';

// Upload configuration
const uploadDir = process.env.UPLOAD_DIR_DOCUMENTS || './uploads/documents';
const maxFileSize = 20 * 1024 * 1024; // 20MB

// Ensure upload directory exists
fs.mkdir(uploadDir, { recursive: true }).catch(console.error);

const diskStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const storage = isS3Configured() ? multer.memoryStorage() : diskStorage;

export const documentUpload = multer({
  storage,
  limits: { fileSize: maxFileSize },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    const allowedExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, DOC, DOCX and XLS files are allowed'));
    }
  },
});

export interface CreateDocumentInput {
  title: string;
  category?: string;
  description?: string;
}

function resolveDocumentFileUrl(stored: string | null | undefined): string | undefined {
  if (!stored) return undefined;
  if (isS3Key(stored)) return resolveToUrl(stored) || undefined;
  return stored;
}

function mapRowToDocument(row: any): Document {
  return {
    id: row.id,
    title: row.title,
    category: row.category || undefined,
    description: row.description || undefined,
    fileUrl: resolveDocumentFileUrl(row.file_url),
    fileType: row.file_type,
    status: row.status,
    scope: row.scope,
    organizationId: row.organization_id || undefined,
    createdBy: row.created_by,
    createdByRole: row.created_by_role,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function createDocument(
  data: CreateDocumentInput,
  file: Express.Multer.File,
  user: Pick<User, 'id' | 'role'> & { organizationId?: string | null }
): Promise<Document> {
  if (!file) {
    throw new Error('File is required');
  }

  // Only Super Admin can create/upload new documents (templates)
  if (user.role !== 'super_admin') {
    throw new Error('Only Super Admin can upload new documents');
  }

  // Super Admin always creates GLOBAL documents
  const scope: 'GLOBAL' | 'ORG' = 'GLOBAL';
  const organizationId: string | null = null;

  const ext = path.extname(file.originalname).toLowerCase();
  const fileType = ext.replace('.', '').toUpperCase();

  let fileUrl: string;
  if (isS3Configured() && file.buffer) {
    const key = `documents/${uuidv4()}${ext}`;
    fileUrl = await s3Upload(key, file.buffer, file.mimetype);
  } else {
    fileUrl = `/uploads/documents/${file.filename}`;
  }

  const result = await query(
    `INSERT INTO documents
      (title, category, description, file_url, file_type, status, scope, organization_id, created_by, created_by_role)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $8, $9)
     RETURNING *`,
    [
      data.title,
      data.category || null,
      data.description || null,
      fileUrl,
      fileType,
      scope,
      organizationId,
      user.id,
      'SUPER_ADMIN',
    ]
  );

  const docRow = result.rows[0];

  // Create initial version record
  await query(
    `INSERT INTO document_versions (document_id, file_url, version, uploaded_by)
     VALUES ($1, $2, $3, $4)`,
    [docRow.id, fileUrl, '1.0', user.id]
  );

  return mapRowToDocument(docRow);
}

export async function getDocumentsForUser(
  user: Pick<User, 'id' | 'role'> & { organizationId?: string | null }
): Promise<Document[]> {
  let organizationId: string | null = user.organizationId ?? null;

  if ((user.role === 'admin' || user.role === 'employee') && !organizationId) {
    const orgResult = await query(
      `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
      [user.id]
    );
    organizationId = orgResult.rows[0]?.organization_id || null;
  }

  if (user.role === 'super_admin') {
    const result = await query(
      `SELECT * FROM documents
       WHERE status = 'ACTIVE'
       ORDER BY created_at DESC`
    );
    return result.rows.map(mapRowToDocument);
  }

  // Admin / Employee: global + own org documents
  const result = await query(
    `SELECT * FROM documents
     WHERE status = 'ACTIVE'
       AND (
         scope = 'GLOBAL'
         OR (scope = 'ORG' AND organization_id = $1)
       )
     ORDER BY created_at DESC`,
    [organizationId]
  );

  return result.rows.map(mapRowToDocument);
}

export async function getDocumentById(
  id: string,
  user: Pick<User, 'id' | 'role'> & { organizationId?: string | null }
): Promise<Document | null> {
  const result = await query(`SELECT * FROM documents WHERE id = $1`, [id]);
  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];

  if (row.status !== 'ACTIVE') {
    return null;
  }

  if (row.scope === 'GLOBAL') {
    return mapRowToDocument(row);
  }

  // ORG-scoped document: ensure same org (or super_admin)
  if (user.role === 'super_admin') {
    return mapRowToDocument(row);
  }

  let organizationId: string | null = user.organizationId ?? null;
  if (!organizationId) {
    const orgResult = await query(
      `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
      [user.id]
    );
    organizationId = orgResult.rows[0]?.organization_id || null;
  }

  if (!organizationId || row.organization_id !== organizationId) {
    return null;
  }

  return mapRowToDocument(row);
}

export async function updateDocumentMetadata(
  id: string,
  data: Partial<CreateDocumentInput>,
  user: Pick<User, 'id' | 'role'> & { organizationId?: string | null }
): Promise<Document | null> {
  // Fetch existing document for permission check
  const existingResult = await query(`SELECT * FROM documents WHERE id = $1`, [id]);
  if (existingResult.rows.length === 0) {
    return null;
  }
  const existing = existingResult.rows[0];

  // Permission rules:
  // - Super Admin: can edit title, category, description of GLOBAL documents
  // - Admin & Employee: can only edit description (body/content) of GLOBAL documents (templates)
  if (user.role === 'super_admin') {
    // Super Admin can edit all fields of GLOBAL documents
    if (existing.scope !== 'GLOBAL') {
      throw new Error('Super Admin can only edit GLOBAL documents');
    }
    // Allow all fields to be updated
  } else if (user.role === 'admin' || user.role === 'employee') {
    // Admin and Employee can only edit description (body/content) of GLOBAL templates
    if (existing.scope !== 'GLOBAL') {
      throw new Error('Admin and Employees can only edit GLOBAL document templates');
    }
    
    // Restrict: Admin/Employee can only update description, not title or category
    if (data.title !== undefined || data.category !== undefined) {
      throw new Error('Admin and Employees can only edit document description/content, not title or category');
    }
  } else {
    throw new Error('Unauthorized to edit documents');
  }

  // Build update query based on role
  let updateFields: string[] = [];
  let updateValues: any[] = [];
  let paramIndex = 1;

  if (user.role === 'super_admin') {
    // Super Admin can update all fields
    if (data.title !== undefined) {
      updateFields.push(`title = $${++paramIndex}`);
      updateValues.push(data.title);
    }
    if (data.category !== undefined) {
      updateFields.push(`category = $${++paramIndex}`);
      updateValues.push(data.category);
    }
    if (data.description !== undefined) {
      updateFields.push(`description = $${++paramIndex}`);
      updateValues.push(data.description);
    }
  } else {
    // Admin/Employee can only update description
    if (data.description !== undefined) {
      updateFields.push(`description = $${++paramIndex}`);
      updateValues.push(data.description);
    }
  }

  if (updateFields.length === 0) {
    // No fields to update, return existing document
    return mapRowToDocument(existing);
  }

  updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
  updateValues.unshift(id); // id is first parameter

  const updatedResult = await query(
    `UPDATE documents
     SET ${updateFields.join(', ')}
     WHERE id = $1
     RETURNING *`,
    updateValues
  );

  return mapRowToDocument(updatedResult.rows[0]);
}

export async function updateDocumentStatus(
  id: string,
  status: 'ACTIVE' | 'INACTIVE',
  user: Pick<User, 'id' | 'role'> & { organizationId?: string | null }
): Promise<Document | null> {
  const existingResult = await query(`SELECT * FROM documents WHERE id = $1`, [id]);
  if (existingResult.rows.length === 0) {
    return null;
  }
  const existing = existingResult.rows[0];

  // Only Super Admin can update document status
  if (user.role !== 'super_admin') {
    throw new Error('Only Super Admin can update document status');
  }

  if (existing.scope !== 'GLOBAL') {
    throw new Error('Super Admin can only update status for GLOBAL documents');
  }

  const updatedResult = await query(
    `UPDATE documents
     SET status = $2,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING *`,
    [id, status]
  );

  return mapRowToDocument(updatedResult.rows[0]);
}

export async function softDeleteDocument(
  id: string,
  user: Pick<User, 'id' | 'role'> & { organizationId?: string | null }
): Promise<boolean> {
  // Only Super Admin can delete documents
  if (user.role !== 'super_admin') {
    throw new Error('Only Super Admin can delete documents');
  }
  
  const updated = await updateDocumentStatus(id, 'INACTIVE', user);
  return !!updated;
}


