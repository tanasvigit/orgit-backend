import { getClient } from '../config/database';
import * as entityMasterBulkService from '../services/entityMasterBulkService';
import * as taskBulkService from '../services/taskBulkService';
import * as entityMasterBulkQueueService from '../services/entityMasterBulkQueueService';

const ROW_LEVEL_BATCH_SIZE = 10;
/** Re-queue file/row uploads left in processing after a crash or hung worker. */
const STALE_PROCESSING_MINUTES = 10;

/**
 * Process one entity master bulk upload from the queue. Runs on a schedule (cron).
 * File-level: parseAndApply. Row-level: process entity_master_bulk_jobs in batches (checkpoint).
 */
export async function processEntityMasterBulkQueue(): Promise<void> {
  const client = await getClient();
  let uploadId: string;
  let fileContent: Buffer | null;
  let uploadType: string;
  let totalRows: number;
  let organizationId: string;
  let metadata: { userId: string; userOrganizationId: string | null; isSuperAdmin: boolean };

  try {
    // Recover uploads stuck in processing (server restart / hung parse).
    const stale = await client.query(
      `UPDATE entity_master_bulk_uploads
       SET status = 'queued_v2',
           updated_at = NOW(),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'phase', 'queued',
             'requeuedReason', 'stale_processing'
           )
       WHERE status IN ('processing_v2', 'processing')
         AND updated_at < NOW() - make_interval(mins => $1::int)
       RETURNING id, filename, updated_at`,
      [STALE_PROCESSING_MINUTES]
    );
    if (stale.rows.length > 0) {
      console.warn(
        '[EntityMasterBulkWorker] Requeued stale processing upload(s):',
        stale.rows.map((r: { id: string; filename: string }) => `${r.id} (${r.filename})`).join(', ')
      );
    }

    // Claim atomically and use v2 statuses so legacy workers do not re-pick uploads.
    const claimResult = await client.query(
      `WITH picked AS (
         SELECT id
         FROM entity_master_bulk_uploads
         WHERE status = 'queued_v2'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE entity_master_bulk_uploads e
       SET status = 'processing_v2',
           updated_at = NOW(),
           metadata = COALESCE(e.metadata, '{}'::jsonb) || jsonb_build_object('phase', 'processing')
       FROM picked
       WHERE e.id = picked.id
       RETURNING e.id, e.file_content, e.upload_type, e.total_rows, e.organization_id, e.metadata`
    );
    if (claimResult.rows.length === 0) return;

    const row = claimResult.rows[0];
    uploadId = row.id;
    fileContent = row.file_content as Buffer | null;
    uploadType = row.upload_type ?? 'file';
    totalRows = row.total_rows ?? 0;
    organizationId = row.organization_id;
    metadata = row.metadata as { userId: string; userOrganizationId: string | null; isSuperAdmin: boolean };
    console.log('[EntityMasterBulkWorker] Claimed upload', {
      uploadId,
      uploadType,
      totalRows,
      fileBytes: fileContent ? (fileContent as Buffer).length : 0,
    });
  } finally {
    client.release();
  }

  const userId = metadata?.userId;
  const userOrganizationId = metadata?.userOrganizationId ?? null;

  if (fileContent != null) {
    // File-level: full parseAndApply for settings + Tasks sheet (tasks bulk)
    try {
      await entityMasterBulkQueueService.setUploadPhase(uploadId, 'parsing');
      console.log('[EntityMasterBulkWorker] Parsing master sheets…', { uploadId });

      const parseResult = await entityMasterBulkService.parseAndApply(
        fileContent,
        userId,
        userOrganizationId,
        metadata?.isSuperAdmin === true
      );

      await entityMasterBulkQueueService.setUploadPhase(uploadId, 'applying');
      console.log('[EntityMasterBulkWorker] Applying Tasks sheet…', {
        uploadId,
        masterUpdated: parseResult.updated,
        masterErrors: parseResult.errors?.length ?? 0,
      });

      // Also process Tasks sheet using the same Task bulk parser so a single
      // OrgIt Settings workbook upload can create/update tasks.
      let taskResult: { updated?: { tasks?: number }; errors?: Array<{ sheet?: string; row?: number; message: string }> };
      try {
        taskResult = await taskBulkService.parseAndApply(
          fileContent,
          userId,
          organizationId,
          async (info) => {
            const total = Math.max(info.maxRow, info.scanned, 1);
            const clientProgress = await getClient();
            try {
              await clientProgress.query(
                `UPDATE entity_master_bulk_uploads
                 SET total_rows = GREATEST(COALESCE(total_rows, 0), $1),
                     processed_count = $2,
                     failed_count = $3,
                     updated_at = NOW(),
                     metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                       'phase', 'applying',
                       'tasksProgress', jsonb_build_object(
                         'scanned', $2::int,
                         'created', $4::int,
                         'errors', $3::int,
                         'maxRow', $1::int
                       )
                     )
                 WHERE id = $5`,
                [total, info.scanned, info.errors, info.created, uploadId]
              );
            } finally {
              clientProgress.release();
            }
          }
        );
      } catch (taskErr: any) {
        console.error('[EntityMasterBulkWorker] Tasks sheet failed; keeping master result', {
          uploadId,
          error: taskErr?.message || String(taskErr),
        });
        taskResult = {
          updated: { tasks: 0 },
          errors: [{ sheet: 'Tasks', message: taskErr?.message || String(taskErr) }],
        };
      }

      const combinedErrors = [
        ...(parseResult.errors || []),
        ...(taskResult.errors || []),
      ];
      const uploadSummary = {
        ...(parseResult.updated || {}),
        tasks: taskResult.updated?.tasks ?? 0,
        totalErrors: combinedErrors.length,
      };
      const client2 = await getClient();
      try {
        await client2.query(
          `UPDATE entity_master_bulk_uploads
           SET status = 'completed', processed_count = 1, failed_count = 0,
               completed_at = NOW(), updated_at = NOW(),
               error_summary = $1,
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                 'summary', $2::jsonb,
                 'phase', 'completed'
               )
           WHERE id = $3`,
          [
            combinedErrors.length > 0 ? JSON.stringify(combinedErrors.slice(0, 500)) : null,
            JSON.stringify(uploadSummary),
            uploadId,
          ]
        );
      } finally {
        client2.release();
      }
      console.log('[EntityMasterBulkWorker] Upload completed', {
        uploadId,
        summary: uploadSummary,
        errorCount: combinedErrors.length,
      });
    } catch (err: any) {
      const errorMessage = err?.message || String(err);
      console.error('[EntityMasterBulkWorker] Upload failed', { uploadId, error: errorMessage });
      const client2 = await getClient();
      try {
        await client2.query(
          `UPDATE entity_master_bulk_uploads
           SET status = 'failed', failed_count = 1, completed_at = NOW(), updated_at = NOW(),
               error_summary = $1,
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('phase', 'failed')
           WHERE id = $2`,
          [JSON.stringify([{ message: errorMessage }]), uploadId]
        );
      } finally {
        client2.release();
      }
    }
    return;
  }

  if (uploadType === 'employees' || uploadType === 'service_list' || uploadType === 'entity_list') {
    await processRowLevelUpload(uploadId, uploadType, totalRows, organizationId);
  }
}

async function processRowLevelUpload(
  uploadId: string,
  uploadType: string,
  totalRows: number,
  organizationId: string
): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const jobResult = await client.query(
      `SELECT id, job_type, row_index, payload
       FROM entity_master_bulk_jobs
       WHERE upload_id = $1 AND status = 'pending'
       ORDER BY row_index ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [uploadId, ROW_LEVEL_BATCH_SIZE]
    );
    const jobs = jobResult.rows;
    if (jobs.length === 0) {
      await client.query('COMMIT');
      const countResult = await client.query(
        `SELECT processed_count, failed_count FROM entity_master_bulk_uploads WHERE id = $1`,
        [uploadId]
      );
      const pc = countResult.rows[0]?.processed_count ?? 0;
      const fc = countResult.rows[0]?.failed_count ?? 0;
      if (pc + fc >= totalRows && totalRows >= 0) {
        const errResult = await client.query(
          `SELECT row_index, error_message FROM entity_master_bulk_jobs WHERE upload_id = $1 AND status = 'failed' ORDER BY row_index LIMIT 500`,
          [uploadId]
        );
        const errorSummary = errResult.rows.map((r: any) => ({ row: r.row_index, message: r.error_message || '' }));
        await client.query(
          `UPDATE entity_master_bulk_uploads
           SET status = 'completed', completed_at = NOW(), updated_at = NOW(), error_summary = $1
           WHERE id = $2`,
          [errorSummary.length > 0 ? JSON.stringify(errorSummary) : null, uploadId]
        );
      }
      return;
    }
    for (const job of jobs) {
      const jobId = job.id;
      const jobType = job.job_type;
      const payload = job.payload as any;
      await client.query(
        `UPDATE entity_master_bulk_jobs SET status = 'processing', updated_at = NOW() WHERE id = $1`,
        [jobId]
      );
      try {
        if (jobType === 'employee') {
          const resultId = await entityMasterBulkService.createEmployeeFromPayload(client, payload, organizationId);
          await client.query(
            `UPDATE entity_master_bulk_jobs SET status = 'completed', result_id = $1, processed_at = NOW(), updated_at = NOW() WHERE id = $2`,
            [resultId, jobId]
          );
          await client.query(
            `UPDATE entity_master_bulk_uploads SET processed_count = processed_count + 1, updated_at = NOW() WHERE id = $1`,
            [uploadId]
          );
        } else if (jobType === 'service_list') {
          await entityMasterBulkService.createTaskServiceFromPayload(client, payload, organizationId);
          await client.query(
            `UPDATE entity_master_bulk_jobs SET status = 'completed', processed_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [jobId]
          );
          await client.query(
            `UPDATE entity_master_bulk_uploads SET processed_count = processed_count + 1, updated_at = NOW() WHERE id = $1`,
            [uploadId]
          );
        } else if (jobType === 'entity_list') {
          const resultId = await entityMasterBulkService.createClientEntityFromPayload(client, payload, organizationId);
          await client.query(
            `UPDATE entity_master_bulk_jobs SET status = 'completed', result_id = $1, processed_at = NOW(), updated_at = NOW() WHERE id = $2`,
            [resultId, jobId]
          );
          await client.query(
            `UPDATE entity_master_bulk_uploads SET processed_count = processed_count + 1, updated_at = NOW() WHERE id = $1`,
            [uploadId]
          );
        }
      } catch (err: any) {
        const errorMessage = err?.message ?? String(err);
        await client.query(
          `UPDATE entity_master_bulk_jobs SET status = 'failed', error_message = $1, processed_at = NOW(), updated_at = NOW() WHERE id = $2`,
          [errorMessage.slice(0, 2000), jobId]
        );
        await client.query(
          `UPDATE entity_master_bulk_uploads SET failed_count = failed_count + 1, updated_at = NOW() WHERE id = $1`,
          [uploadId]
        );
      }
    }
    const statsResult = await client.query(
      `SELECT processed_count, failed_count FROM entity_master_bulk_uploads WHERE id = $1`,
      [uploadId]
    );
    const pcAfter = statsResult.rows[0]?.processed_count ?? 0;
    const fcAfter = statsResult.rows[0]?.failed_count ?? 0;
    const batchesCompleted = Math.max(1, Math.ceil((pcAfter + fcAfter) / ROW_LEVEL_BATCH_SIZE));
    console.log('[EntityMasterBulkWorker] Batch completed', {
      uploadId,
      uploadType,
      batchNumber: batchesCompleted,
      batchSize: jobs.length,
      processedCount: pcAfter,
      failedCount: fcAfter,
      totalRows,
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const checkClient = await getClient();
  try {
    const r = await checkClient.query(
      `SELECT processed_count, failed_count FROM entity_master_bulk_uploads WHERE id = $1`,
      [uploadId]
    );
    const pc = r.rows[0]?.processed_count ?? 0;
    const fc = r.rows[0]?.failed_count ?? 0;
    if (pc + fc >= totalRows && totalRows >= 0) {
      const errResult = await checkClient.query(
        `SELECT row_index, error_message FROM entity_master_bulk_jobs WHERE upload_id = $1 AND status = 'failed' ORDER BY row_index LIMIT 500`
      );
      const errorSummary = errResult.rows.map((row: any) => ({ row: row.row_index, message: row.error_message || '' }));
      await checkClient.query(
        `UPDATE entity_master_bulk_uploads
         SET status = 'completed', completed_at = NOW(), updated_at = NOW(), error_summary = $1
         WHERE id = $2`,
        [errorSummary.length > 0 ? JSON.stringify(errorSummary) : null, uploadId]
      );
    }
  } finally {
    checkClient.release();
  }
}
