/**
 * Smoke-test a FULL fresh bootstrap against a temporary database.
 * Creates DB, runs db:bootstrap logic, then drops DB.
 *
 * Requires CREATEDB privilege for DB_USER.
 *
 * Usage:
 *   npm run db:smoke
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');
const { assertOrderComplete } = require('./lib/migrationFiles');

const smokeDb =
  process.env.SMOKE_DB_NAME ||
  `orgit_smoke_${Date.now().toString(36)}`;

async function adminClient() {
  return new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: 'postgres',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });
}

async function main() {
  const orderCheck = assertOrderComplete();
  if (!orderCheck.ok) {
    console.error('ORDER.json is incomplete. Fix with: npm run migrate:check-order');
    if (orderCheck.missingFromOrder.length) {
      console.error('Missing from ORDER.json:', orderCheck.missingFromOrder.join(', '));
    }
    process.exit(1);
  }

  console.log('Order check OK.');
  console.log('Creating smoke database:', smokeDb);

  const admin = await adminClient();
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(smokeDb)}`);
    await admin.query(`CREATE DATABASE ${quoteIdent(smokeDb)}`);
  } finally {
    await admin.end();
  }

  const env = {
    ...process.env,
    DB_NAME: smokeDb,
  };

  console.log('Running bootstrap against', smokeDb, '…');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'bootstrap-db.js')], {
    cwd: path.join(__dirname, '..'),
    env,
    encoding: 'utf8',
    stdio: 'inherit',
  });

  const admin2 = await adminClient();
  await admin2.connect();
  try {
    await admin2.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [smokeDb]);
    await admin2.query(`DROP DATABASE IF EXISTS ${quoteIdent(smokeDb)}`);
    console.log('Dropped smoke database:', smokeDb);
  } finally {
    await admin2.end();
  }

  if (result.status !== 0) {
    console.error('Smoke bootstrap FAILED.');
    process.exit(result.status || 1);
  }

  console.log('Smoke bootstrap PASSED.');
}

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe database name: ${name}`);
  }
  return `"${name}"`;
}

main().catch((err) => {
  console.error('Smoke test failed:', err.message);
  process.exit(1);
});
