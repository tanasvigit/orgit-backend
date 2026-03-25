import { getClient } from '../config/database';
import { createTaskFromPayload } from '../services/taskBulkService';
import type { TaskBulkJobPayload } from '../services/taskBulkService';

const BATCH_SIZE = 50;

/**
 * Process pending task bulk jobs. Runs on a schedule (cron).
 * Uses FOR UPDATE SKIP LOCKED for safe concurrent workers.
 */
export async function processTaskBulkQueue(): Promise<void> {
  const client = await getClient();
  try {
    const uploadsResult = await client.query(
      `SELECT id, organization_id, created_by, total_rows, processed_count, failed_count
       FROM task_bulk_uploads
       WHERE status = 'queued'
       ORDER BY created_at ASC
       LIMIT 10`
    );

    for (const upload of uploadsResult.rows) {
      const uploadId = upload.id;
      const organizationId = upload.organization_id;
      const createdBy = upload.created_by;
      const totalRows = upload.total_rows;

      const claimResult = await client.query(
        `UPDATE task_bulk_uploads
         SET status = 'processing', updated_at = NOW()
         WHERE id = $1 AND status = 'queued'
         RETURNING id`,
        [uploadId]
      );
      if (claimResult.rows.length === 0) {
        continue;
      }

      try {
        await client.query('BEGIN');

        const jobsResult = await client.query(
          `SELECT id, payload FROM task_bulk_jobs
           WHERE upload_id = $1 AND status = 'pending'
           ORDER BY row_index ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED`,
          [uploadId, BATCH_SIZE]
        );

        for (const job of jobsResult.rows) {
          const jobId = job.id;
          const payload = job.payload as TaskBulkJobPayload;

          try {
            await client.query(
              `UPDATE task_bulk_jobs SET status = 'processing', updated_at = NOW() WHERE id = $1`,
              [jobId]
            );

            const { taskId } = await createTaskFromPayload(
              client,
              payload,
              organizationId,
              createdBy
            );

            await client.query(
              `UPDATE task_bulk_jobs SET status = 'completed', task_id = $1, processed_at = NOW(), updated_at = NOW() WHERE id = $2`,
              [taskId, jobId]
            );
            await client.query(
              `UPDATE task_bulk_uploads SET processed_count = processed_count + 1, updated_at = NOW() WHERE id = $1`,
              [uploadId]
            );
          } catch (err: any) {
            const errorMessage = err?.message || String(err);
            console.error('[TaskBulkWorker] Job failed', { jobId, uploadId, error: errorMessage });
            await client.query(
              `UPDATE task_bulk_jobs SET status = 'failed', error_message = $1, processed_at = NOW(), updated_at = NOW() WHERE id = $2`,
              [errorMessage.slice(0, 10000), jobId]
            );
            await client.query(
              `UPDATE task_bulk_uploads SET failed_count = failed_count + 1, updated_at = NOW() WHERE id = $1`,
              [uploadId]
            );
          }
        }

        await client.query('COMMIT');
      } catch (err: any) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[TaskBulkWorker] Upload batch failed', { uploadId, error: err?.message });
      }

      const updatedUpload = await client.query(
        `SELECT processed_count, failed_count FROM task_bulk_uploads WHERE id = $1`,
        [uploadId]
      );
      const row = updatedUpload.rows[0];
      const currentProcessed = parseInt(String(row?.processed_count), 10) || 0;
      const currentFailed = parseInt(String(row?.failed_count), 10) || 0;

      if (currentProcessed + currentFailed >= totalRows) {
        const finalStatus = currentFailed > 0 ? 'failed' : 'completed';
        await client.query(
          `UPDATE task_bulk_uploads SET status = $1, completed_at = NOW(), updated_at = NOW() WHERE id = $2`,
          [finalStatus, uploadId]
        );
      }
    }
  } finally {
    client.release();
  }
}
