/**
 * Add missing org-structure columns on client_entities (safe if already present).
 * Usage: npm run migrate:repair-client-entities
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

const sqlPath = path.join(
  __dirname,
  '..',
  'migrations',
  '20260515130000_repair-client-entities-org-columns.sql'
);

async function run() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'orgit',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  try {
    await client.connect();
    console.log('Connected to', process.env.DB_NAME || 'orgit', 'at', process.env.DB_HOST);
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await client.query(sql);
    const cols = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'client_entities'
         AND column_name IN (
           'org_structure_node_id',
           'org_structure_path',
           'org_field_values',
           'entity_type',
           'pan',
           'status'
         )
       ORDER BY column_name`
    );
    console.log('client_entities columns present:', cols.rows.map((r) => r.column_name).join(', '));
    console.log('Repair completed.');
  } catch (err) {
    console.error('Repair failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
