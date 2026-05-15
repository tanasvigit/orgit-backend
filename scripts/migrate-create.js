/**
 * Create a new timestamped migration file (sorts correctly on npm run migrate).
 *
 * Usage:
 *   npm run migrate:create -- add-my-feature
 *   npm run migrate:create add-my-feature
 */
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function slugify(name) {
  return String(name || 'migration')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function timestamp() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

const rawName = process.argv.slice(2).join(' ').trim();
if (!rawName) {
  console.error('Usage: npm run migrate:create -- <migration-name>');
  console.error('Example: npm run migrate:create -- add-org-field-values');
  process.exit(1);
}

const slug = slugify(rawName);
const filename = `${timestamp()}_${slug}.sql`;
const fullPath = path.join(MIGRATIONS_DIR, filename);

if (!fs.existsSync(MIGRATIONS_DIR)) {
  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
}

const template = `-- ${slug}\n\n`;

fs.writeFileSync(fullPath, template, 'utf8');
console.log('Created:', fullPath);
console.log('Edit the file, then run: npm run migrate');
