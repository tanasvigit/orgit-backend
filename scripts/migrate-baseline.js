/**
 * One-time: mark ALL current migrations/*.sql as applied WITHOUT running SQL.
 * Use when the database already has the schema (manual runs / old process) but
 * schema_migrations is empty or incomplete — so `npm run migrate` only runs NEW files.
 *
 * Usage:
 *   npm run migrate:baseline
 */
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

async function run() {
  const exclude = new Set(
    (process.env.MIGRATE_BASELINE_EXCLUDE || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const files = listMigrationFiles({ warn: true });

  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'orgit',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  try {
    await client.connect();
    await ensureMigrationsTable(client);

    let marked = 0;
    for (const { filename } of files) {
      if (exclude.has(filename)) {
        console.log('[skip]', filename, '(excluded — will run on next migrate)');
        continue;
      }
      const res = await client.query(
        `INSERT INTO schema_migrations (filename, applied_at)
         VALUES ($1, CURRENT_TIMESTAMP)
         ON CONFLICT (filename) DO NOTHING
         RETURNING filename`,
        [filename]
      );
      if (res.rowCount > 0) {
        marked += 1;
        console.log('[marked]', filename);
      }
    }

    console.log(`\nBaseline complete. Newly marked: ${marked}, total files: ${files.length}.`);
    if (exclude.size > 0) {
      console.log('Excluded (run next):', [...exclude].join(', '));
    }
    console.log('Now run: npm run migrate');
  } catch (err) {
    console.error('Baseline failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
