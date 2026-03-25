import ExcelJS from 'exceljs';
import { getClient } from '../config/database';
import { createHash } from 'crypto';
import {
  buildEmployeePayloadsFromSheet,
  buildServiceListPayloadsFromSheet,
  buildEntityListPayloadsFromSheet,
} from './entityMasterBulkService';

export interface EntityMasterBulkEnqueueResult {
  uploadId: string;
  status: 'queued' | 'queued_v2';
}

export interface EntityMasterBulkUploadStatus {
  status: string;
  processedCount: number;
  failedCount: number;
  totalRows?: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  errors?: Array<{ sheet?: string; row?: number; message: string }>;
}

const ROW_LEVEL_SHEET_NAMES = ['Employees', 'Service List', 'Entity List', 'Client Entities'];

/**
 * Enqueue an Entity Master bulk upload. For single-sheet Employees/Service List/Entity List, enqueues row-level jobs (checkpoint); otherwise stores file for file-level processing.
 */
export async function enqueueEntityMasterBulkUpload(
  buffer: Buffer,
  filename: string,
  userId: string,
  organizationId: string,
  isSuperAdmin: boolean
): Promise<EntityMasterBulkEnqueueResult> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const metadata = {
      userId,
      userOrganizationId: organizationId,
      isSuperAdmin,
    };
    const fileHash = createHash('sha256').update(buffer).digest('hex');

    // Idempotency guard: prevent duplicate uploads of the same file while an upload
    // is already queued/processing (common when UI triggers multiple requests).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [fileHash]);
    const existing = await client.query(
        `SELECT id, status
       FROM entity_master_bulk_uploads
       WHERE organization_id = $1
         AND created_by = $2
         AND (metadata->>'fileHash') = $3
         AND (
          status IN ('queued', 'queued_v2', 'processing', 'processing_v2')
           OR (status = 'completed' AND created_at >= NOW() - INTERVAL '15 minutes')
         )
       ORDER BY created_at DESC
       LIMIT 1`,
      [organizationId, userId, fileHash]
    );
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return { uploadId: existing.rows[0].id, status: existing.rows[0].status || 'queued' };
    }
    let uploadType: 'file' | 'employees' | 'service_list' | 'entity_list' = 'file';
    let totalRows = 0;
    let fileContent: Buffer | null = buffer;
    const payloads: Array<{ job_type: 'employee' | 'service_list' | 'entity_list'; payload: object }> = [];

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    if (workbook.worksheets.length === 1) {
      const sheetName = workbook.worksheets[0].name;
      if (ROW_LEVEL_SHEET_NAMES.includes(sheetName)) {
        if (sheetName === 'Employees') {
          const list = await buildEmployeePayloadsFromSheet(workbook, client, organizationId);
          totalRows = list.length;
          uploadType = 'employees';
          list.forEach((p) => payloads.push({ job_type: 'employee', payload: p }));
        } else if (sheetName === 'Service List') {
          const list = await buildServiceListPayloadsFromSheet(workbook, client, organizationId, isSuperAdmin);
          totalRows = list.length;
          uploadType = 'service_list';
          list.forEach((p) => payloads.push({ job_type: 'service_list', payload: p }));
        } else if (sheetName === 'Entity List' || sheetName === 'Client Entities') {
          const list = await buildEntityListPayloadsFromSheet(workbook, client, organizationId, isSuperAdmin);
          totalRows = list.length;
          uploadType = 'entity_list';
          list.forEach((p) => payloads.push({ job_type: 'entity_list', payload: p }));
        }
        if (uploadType !== 'file') fileContent = null;
      }
    }

    const result = await client.query(
      `INSERT INTO entity_master_bulk_uploads
       (organization_id, created_by, filename, status, file_content, metadata, processed_count, failed_count, upload_type, total_rows)
       VALUES ($1, $2, $3, 'queued_v2', $4, $5, 0, 0, $6, $7)
       RETURNING id`,
      [
        organizationId,
        userId,
        filename.slice(0, 255),
        fileContent,
        JSON.stringify({ ...metadata, fileHash }),
        uploadType,
        totalRows,
      ]
    );
    const uploadId = result.rows[0].id;

    if (payloads.length > 0) {
      for (let rowIndex = 0; rowIndex < payloads.length; rowIndex++) {
        const { job_type, payload } = payloads[rowIndex];
        await client.query(
          `INSERT INTO entity_master_bulk_jobs (upload_id, job_type, row_index, status, payload)
           VALUES ($1, $2, $3, 'pending', $4)`,
          [uploadId, job_type, rowIndex + 1, JSON.stringify(payload)]
        );
      }
    }

    await client.query('COMMIT');
    return { uploadId, status: 'queued_v2' };
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {}
    client.release();
  }
}

/**
 * Get status for an entity master bulk upload. Returns null if not found or wrong organization.
 * For row-level uploads (employees/service_list/entity_list), includes totalRows and errors from failed jobs.
 */
export async function getUploadStatus(
  uploadId: string,
  organizationId: string
): Promise<EntityMasterBulkUploadStatus | null> {
  const client = await getClient();
  try {
    const result = await client.query(
      `SELECT status, processed_count, failed_count, total_rows, upload_type, created_at, updated_at, completed_at, error_summary
       FROM entity_master_bulk_uploads
       WHERE id = $1 AND organization_id = $2`,
      [uploadId, organizationId]
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    let errors: Array<{ sheet?: string; row?: number; message: string }> | undefined;
    if (row.error_summary && Array.isArray(row.error_summary)) {
      errors = row.error_summary;
    } else if (row.upload_type && ['employees', 'service_list', 'entity_list'].includes(row.upload_type)) {
      const jobErrors = await client.query(
        `SELECT row_index, error_message FROM entity_master_bulk_jobs WHERE upload_id = $1 AND status = 'failed' ORDER BY row_index LIMIT 100`,
        [uploadId]
      );
      if (jobErrors.rows.length > 0) {
        errors = jobErrors.rows.map((r: any) => ({ row: r.row_index, message: r.error_message || '' }));
      }
    }

    const status: EntityMasterBulkUploadStatus = {
      status: row.status,
      processedCount: row.processed_count ?? 0,
      failedCount: row.failed_count ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      errors,
    };
    if (row.total_rows != null && row.total_rows > 0) {
      status.totalRows = row.total_rows;
    }
    return status;
  } finally {
    client.release();
  }
}
