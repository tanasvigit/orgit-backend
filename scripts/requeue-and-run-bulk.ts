/**
 * Requeue a stuck entity-master upload and run the worker once.
 *
 *   npx tsx scripts/requeue-and-run-bulk.ts [uploadId]
 */
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { Client } from 'pg';
import { processEntityMasterBulkQueue } from '../src/jobs/entityMasterBulkWorker';

async function main() {
  const uploadId = process.argv[2] || 'e303b61c-e149-4527-a748-1146313bd511';
  const c = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  await c.connect();
  const r = await c.query(
    `UPDATE entity_master_bulk_uploads
     SET status = 'queued_v2',
         completed_at = NULL,
         updated_at = NOW(),
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('phase', 'queued', 'requeuedReason', 'manual')
     WHERE id = $1
     RETURNING id, filename, status, upload_type`,
    [uploadId]
  );
  console.log('Requeued:', r.rows[0] || 'not found');
  await c.end();

  console.log('Running worker…');
  const started = Date.now();
  await processEntityMasterBulkQueue();
  console.log(`Worker finished in ${Date.now() - started}ms`);

  const c2 = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
  await c2.connect();
  const s = await c2.query(
    `SELECT id, status, processed_count, failed_count, metadata->>'phase' AS phase,
            metadata->'summary' AS summary,
            LEFT(COALESCE(error_summary::text, ''), 800) AS errors
     FROM entity_master_bulk_uploads WHERE id = $1`,
    [uploadId]
  );
  console.log('Final status:', JSON.stringify(s.rows[0], null, 2));
  await c2.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
