/**
 * Run migration script
 * Usage: node scripts/run-migration.js migrations/add-document-instance-id-to-tasks.sql
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

async function runMigration(migrationFile) {
  const pool = new Pool(poolConfig);
  const client = await pool.connect();

  try {
    console.log(`📄 Reading migration file: ${migrationFile}`);
    const sql = fs.readFileSync(migrationFile, 'utf8');

    console.log('🔄 Running migration...');
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');

    console.log('✅ Migration completed successfully!');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

const migrationFile = process.argv[2] || 'migrations/add-document-instance-id-to-tasks.sql';
const fullPath = path.join(__dirname, '..', migrationFile);

if (!fs.existsSync(fullPath)) {
  console.error(`❌ Migration file not found: ${fullPath}`);
  process.exit(1);
}

runMigration(fullPath)
  .then(() => {
    console.log('✨ Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Error:', error);
    process.exit(1);
  });
