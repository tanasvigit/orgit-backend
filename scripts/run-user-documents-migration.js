/**
 * Run add-user-documents-table.sql migration using .env DB credentials.
 * Creates user_documents table for Document Library / Create / Access flow.
 * Usage (from orgit-api folder): node scripts/run-user-documents-migration.js
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

const sqlPath = path.join(__dirname, '..', 'migrations', 'add-user-documents-table.sql');

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
    console.log('✅ Connected to', process.env.DB_NAME || 'orgit', 'at', process.env.DB_HOST);

    const sql = fs.readFileSync(sqlPath, 'utf8');
    await client.query(sql);
    console.log('✅ Migration completed: user_documents table created.');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    console.error(err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
