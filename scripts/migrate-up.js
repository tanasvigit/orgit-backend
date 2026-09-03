/**
 * Apply pending SQL migrations in dependency order (migrations/ORDER.json).
 * Tracks applied files in schema_migrations — safe to re-run (skips applied).
 *
 * Usage (from orgit-backend root):
 *   npm run migrate
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');
const { listMigrationFiles } = require('./lib/migrationFiles');

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
  const res = await client.query(
    'SELECT 1 FROM schema_migrations WHERE filename = $1 LIMIT 1',
    [filename]
  );
  return res.rows.length > 0;
}

async function markApplied(client, filename) {
  await client.query(
    `INSERT INTO schema_migrations (filename, applied_at)
     VALUES ($1, CURRENT_TIMESTAMP)
     ON CONFLICT (filename) DO NOTHING`,
    [filename]
  );
}

async function run() {
  const files = listMigrationFiles({ warn: true });
  if (files.length === 0) {
    console.log('No .sql files in migrations/');
    return;
  }

  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'orgit',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionTimeoutMillis: 15000,
  });

  try {
    await client.connect();
    await client.query('SET statement_timeout = 300000');
    console.log('Connected to', process.env.DB_NAME || 'orgit', 'at', process.env.DB_HOST);
    await ensureMigrationsTable(client);
    console.log('Checking', files.length, 'migration file(s)…');

    const pending = [];
    for (const file of files) {
      if (!(await isApplied(client, file.filename))) {
        pending.push(file);
      }
    }

    if (pending.length === 0) {
      console.log('\nDone. Applied: 0, already applied:', files.length);
      console.log('Database is up to date.');
      return;
    }

    console.log(`\n${pending.length} pending migration(s) to apply:\n`);
    pending.forEach((f) => console.log('  -', f.filename));
    console.log('');

    let applied = 0;
    const skipped = files.length - pending.length;

    for (const { filename, fullPath } of pending) {
      const sql = fs.readFileSync(fullPath, 'utf8');
      console.log('[apply]', filename, '…');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await markApplied(client, filename);
        await client.query('COMMIT');
        applied += 1;
        console.log('  ok');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${filename}: ${err.message}`);
      }
    }

    console.log(`\nDone. Applied: ${applied}, already applied: ${skipped}.`);
    if (applied === 0) {
      console.log('Database is up to date.');
    }
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
