/**
 * Run database/schema.sql first, then all SQL migration files in migrations/ in alphabetical order.
 * Migrations assume the base schema (e.g. messages, users) already exists.
 * Uses .env for DB connection (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD). Stops on first failure.
 *
 * From orgit-backend root (recommended):
 *   npm run migrate:all
 *   npm run migrate:all -- --dry-run           # list steps only
 *   npm run migrate:all -- --migrations-only     # skip schema.sql; run only migrations/*.sql
 *
 * Or:
 *   node scripts/run-all-migrations.js
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const poolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'orgit',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
};

const SCHEMA_PATH = path.join(__dirname, '..', 'database', 'schema.sql');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function getMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return files.map((f) => path.join(MIGRATIONS_DIR, f));
}

async function runAllMigrations(dryRun = false, migrationsOnly = false) {
  const files = getMigrationFiles();
  if (files.length === 0 && migrationsOnly) {
    console.log('No .sql files found in migrations/');
    return;
  }

  const runSchema = !migrationsOnly && fs.existsSync(SCHEMA_PATH);
  if (runSchema) {
    console.log('Step 0: database/schema.sql (base schema)');
    if (!dryRun) console.log('  (will run first)\n');
  }
  console.log(`Found ${files.length} migration(s) in migrations/\n`);

  if (dryRun) {
    if (runSchema) console.log('  0. database/schema.sql');
    files.forEach((f, i) => console.log(`  ${i + 1}. ${path.basename(f)}`));
    console.log('\nDry run — no migrations executed.');
    return;
  }

  const pool = new Pool(poolConfig);
  let run = 0;
  let failed = null;

  // Apply base schema first (database/schema.sql — required for migrations that ALTER messages, etc.)
  if (runSchema) {
    const client = await pool.connect();
    try {
      console.log('[0] database/schema.sql');
      const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log('  ✅ schema.sql');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('  ❌ schema.sql:', error.message);
      failed = { migrationPath: 'schema.sql', error };
      client.release();
      await pool.end();
      console.error(`\nStopped after failure. Last error: ${failed.error.message}`);
      process.exit(1);
    } finally {
      if (!failed) client.release();
    }
  }

  for (const migrationPath of files) {
    const name = path.basename(migrationPath);
    const client = await pool.connect();
    try {
      console.log(`[${run + 1}/${files.length}] ${name}`);
      const sql = fs.readFileSync(migrationPath, 'utf8');
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log(`  ✅ ${name}`);
      run++;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`  ❌ ${name}:`, error.message);
      failed = { migrationPath: name, error };
      break;
    } finally {
      client.release();
    }
  }

  await pool.end();

  if (failed) {
    console.error(`\nStopped after failure. Last error: ${failed.error.message}`);
    process.exit(1);
  }
  console.log(`\n✨ Done: ${runSchema ? 'schema.sql + ' : ''}${run} migration(s) completed successfully.`);
}

const dryRun = process.argv.includes('--dry-run');
const migrationsOnly = process.argv.includes('--migrations-only');
runAllMigrations(dryRun, migrationsOnly)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('💥 Error:', err);
    process.exit(1);
  });
