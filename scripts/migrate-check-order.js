/**
 * Validate migrations/ORDER.json covers every *.sql file.
 * Usage: npm run migrate:check-order
 */
const { assertOrderComplete, listMigrationFiles } = require('./lib/migrationFiles');

const check = assertOrderComplete();
const ordered = listMigrationFiles({ warn: false });

console.log('Migration files on disk:', check.onDiskCount);
console.log('ORDER.json entries:', check.orderCount);
console.log('Effective apply order:', ordered.length, 'file(s)\n');

if (check.missingFromOrder.length) {
  console.error('FAIL: SQL files not listed in ORDER.json:');
  check.missingFromOrder.forEach((f) => console.error('  -', f));
}

if (check.missingFromDisk.length) {
  console.error('FAIL: ORDER.json entries missing on disk:');
  check.missingFromDisk.forEach((f) => console.error('  -', f));
}

if (!check.ok) {
  process.exit(1);
}

console.log('OK: ORDER.json matches migrations/*.sql');
console.log('\nApply order:');
ordered.forEach((f, i) => console.log(`  ${String(i + 1).padStart(2, ' ')}. ${f.filename}`));
