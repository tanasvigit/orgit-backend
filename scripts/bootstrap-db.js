/**
 * Bootstrap DB schema + apply all SQL migrations.
 *
 * - Uses DB credentials from .env
 * - Applies database/schema.sql first
 * - Then applies every *.sql file in /migrations (sorted by filename)
 * - Tracks applied files in schema_migrations so it is safe to re-run
 *
 * Usage (from orgit-api folder):
 *   node scripts/bootstrap-db.js
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
const migrationsDir = path.join(__dirname, '..', 'migrations');

function readSql(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

async function isApplied(client, filename) {
  const res = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1 LIMIT 1', [filename]);
  return res.rows.length > 0;
}

async function markApplied(client, filename) {
  await client.query(
    'INSERT INTO schema_migrations (filename, applied_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (filename) DO NOTHING',
    [filename]
  );
}

async function applySqlFile(client, filePath) {
  const filename = path.basename(filePath);

  if (await isApplied(client, filename)) {
    console.log('[skip]', filename);
    return;
  }

  const sql = readSql(filePath);

  console.log('[apply]', filename);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await markApplied(client, filename);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`${filename} failed: ${err.message}`);
  }
}

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

    await ensureMigrationsTable(client);

    // Apply base schema (tracked as a migration entry too)
    await applySqlFile(client, schemaPath);

    // Apply all migrations in filename order
    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.toLowerCase().endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b))
      .map((f) => path.join(migrationsDir, f));

    for (const file of migrationFiles) {
      // Avoid re-applying the consolidated helper scripts if you don’t want them.
      // They are safe to run, but they may duplicate work already covered by other migrations.
      await applySqlFile(client, file);
    }

    console.log('Bootstrap complete.');
  } catch (err) {
    console.error('Bootstrap failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();

