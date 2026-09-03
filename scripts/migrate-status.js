/**
 * Show which migrations are applied vs pending (ORDER.json order).
 * Usage: npm run migrate:status
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');
const { listMigrationFiles, assertOrderComplete } = require('./lib/migrationFiles');

async function run() {
  const check = assertOrderComplete();
  if (!check.ok) {
    if (check.missingFromOrder.length) {
      console.warn('Migrations missing from ORDER.json:');
      check.missingFromOrder.forEach((f) => console.warn('  -', f));
    }
    if (check.missingFromDisk.length) {
      console.warn('ORDER.json entries missing on disk:');
      check.missingFromDisk.forEach((f) => console.warn('  -', f));
    }
    console.warn('');
  }

  const files = listMigrationFiles({ warn: false });

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
    const res = await client.query('SELECT filename FROM schema_migrations ORDER BY filename');
    const applied = new Set(res.rows.map((r) => r.filename));

    const pending = files.filter((f) => !applied.has(f.filename));
    console.log(`Total migration files: ${files.length}`);
    console.log(`Applied: ${[...applied].filter((f) => f.endsWith('.sql')).length}`);
    console.log(`Pending: ${pending.length}\n`);

    if (pending.length > 0) {
      console.log('Pending files (dependency order):');
      pending.forEach((f) => console.log('  -', f.filename));
      console.log('\nIf the DB already has this schema, run once: npm run migrate:baseline');
      console.log('Then run: npm run migrate');
    } else {
      console.log('Database is up to date (all migration files recorded).');
    }
  } catch (err) {
    if (err.message && err.message.includes('schema_migrations')) {
      console.log('schema_migrations table does not exist yet.');
      console.log('All', files.length, 'files are pending.');
      console.log('\nIf DB already has schema, run: npm run migrate:baseline');
      console.log('If fresh DB, run: npm run db:bootstrap');
    } else {
      console.error('Error:', err.message);
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

run();
