/**
 * Shared migration file discovery + dependency-safe ordering.
 *
 * Filename sort alone is unsafe: dated files (2026…) run before add-* files
 * that create columns/tables they depend on.
 *
 * Source of truth: migrations/ORDER.json
 * - Listed files run in that order
 * - Any *.sql not listed is appended (sorted) with a console warning
 * - migrate:create appends new files to ORDER.json automatically
 */
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');
const ORDER_PATH = path.join(MIGRATIONS_DIR, 'ORDER.json');

function readDiskSqlFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.sql'));
}

function readOrderList() {
  if (!fs.existsSync(ORDER_PATH)) {
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(ORDER_PATH, 'utf8'));
  if (!Array.isArray(raw)) {
    throw new Error('migrations/ORDER.json must be a JSON array of filenames');
  }
  return raw.filter((f) => typeof f === 'string' && f.trim().length > 0);
}

/**
 * @returns {{ filename: string, fullPath: string }[]}
 */
function listMigrationFiles({ warn = true } = {}) {
  const onDisk = new Set(readDiskSqlFiles());
  const ordered = [];
  const seen = new Set();

  for (const filename of readOrderList()) {
    if (!onDisk.has(filename)) {
      if (warn) {
        console.warn(`[migrate] ORDER.json lists missing file (skipped): ${filename}`);
      }
      continue;
    }
    if (seen.has(filename)) continue;
    seen.add(filename);
    ordered.push({
      filename,
      fullPath: path.join(MIGRATIONS_DIR, filename),
    });
  }

  const extras = [...onDisk]
    .filter((f) => !seen.has(f))
    .sort((a, b) => a.localeCompare(b));

  if (extras.length > 0 && warn) {
    console.warn(
      `[migrate] ${extras.length} migration(s) not in ORDER.json — appending at end:\n` +
        extras.map((f) => `  - ${f}`).join('\n') +
        `\nAdd them to migrations/ORDER.json (or use npm run migrate:create).`
    );
  }

  for (const filename of extras) {
    ordered.push({
      filename,
      fullPath: path.join(MIGRATIONS_DIR, filename),
    });
  }

  return ordered;
}

function assertOrderComplete() {
  const onDisk = readDiskSqlFiles().sort((a, b) => a.localeCompare(b));
  const order = readOrderList();
  const orderSet = new Set(order);
  const missingFromOrder = onDisk.filter((f) => !orderSet.has(f));
  const missingFromDisk = order.filter((f) => !onDisk.includes(f));

  return {
    ok: missingFromOrder.length === 0 && missingFromDisk.length === 0,
    onDiskCount: onDisk.length,
    orderCount: order.length,
    missingFromOrder,
    missingFromDisk,
  };
}

/** Append filename to ORDER.json if not already present. */
function appendToOrder(filename) {
  const order = readOrderList();
  if (order.includes(filename)) {
    return false;
  }
  order.push(filename);
  fs.writeFileSync(ORDER_PATH, `${JSON.stringify(order, null, 2)}\n`, 'utf8');
  return true;
}

module.exports = {
  MIGRATIONS_DIR,
  ORDER_PATH,
  listMigrationFiles,
  assertOrderComplete,
  appendToOrder,
  readOrderList,
};
