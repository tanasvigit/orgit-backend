/**
 * Show which migrations are applied vs pending.
 * Usage: npm run migrate:status
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function run() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort();

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

    const pending = files.filter((f) => !applied.has(f));
    console.log(`Total migration files: ${files.length}`);
    console.log(`Applied: ${applied.size}`);
    console.log(`Pending: ${pending.length}\n`);

    if (pending.length > 0) {
      console.log('Pending files:');
      pending.forEach((f) => console.log('  -', f));
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
      console.log('If fresh DB, run: npm run migrate');
    } else {
      console.error('Error:', err.message);
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

run();
