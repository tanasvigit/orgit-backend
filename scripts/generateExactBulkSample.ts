/**
 * Generates OrgIt_Master_Bulk_SAMPLE.xlsx — identical to Settings → Bulk download,
 * with sample rows filled on Organisation Structure, Service List, Client List, Employees, Tasks.
 *
 * Usage (from orgit-backend/orgit-backend):
 *   npx tsx scripts/generateExactBulkSample.ts
 *   ORGANIZATION_ID=<uuid> npx tsx scripts/generateExactBulkSample.ts
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { query } from '../src/config/database';
import { buildSampleFilledMasterBulkWorkbook } from '../src/services/masterBulkSampleFill';

dotenv.config();

async function resolveOrganizationId(): Promise<string> {
  const fromEnv = process.env.ORGANIZATION_ID?.trim();
  if (fromEnv) return fromEnv;

  const res = await query(
    `SELECT id::text AS id FROM organizations
     ORDER BY created_at ASC NULLS LAST
     LIMIT 1`
  );
  const id = res.rows?.[0]?.id as string | undefined;
  if (!id) {
    throw new Error(
      'No organization found. Set ORGANIZATION_ID in the environment or create an organization first.'
    );
  }
  return id;
}

async function main(): Promise<void> {
  const organizationId = await resolveOrganizationId();
  console.log(`[generateExactBulkSample] Using organization ${organizationId}`);

  const buffer = await buildSampleFilledMasterBulkWorkbook(organizationId);
  const buf = Buffer.from(buffer);
  const outPaths = [
    path.resolve(__dirname, '..', 'OrgIt_Master_Bulk_SAMPLE.xlsx'),
    path.resolve(__dirname, '..', '..', 'OrgIt_Master_Bulk_SAMPLE.xlsx'),
  ];
  for (const outPath of outPaths) {
    try {
      fs.writeFileSync(outPath, buf);
      console.log(`[generateExactBulkSample] Wrote ${outPath}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EBUSY' || code === 'EPERM') {
        console.warn(`[generateExactBulkSample] Skipped (file open elsewhere): ${outPath}`);
      } else {
        throw err;
      }
    }
  }
  console.log(
    '[generateExactBulkSample] This file matches OrgIt_Master_Bulk.xlsx (validations, hidden sheets, dynamic columns) with sample data filled.'
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[generateExactBulkSample] Failed:', err);
    process.exit(1);
  });
