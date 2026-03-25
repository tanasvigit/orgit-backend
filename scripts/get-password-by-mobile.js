/**
 * Get / set known password for a user by mobile number
 *
 * IMPORTANT: Hashed passwords (bcrypt) cannot be "recovered" or reversed.
 * The original password is not stored anywhere — only a one-way hash is stored.
 *
 * This script gives you a known password in two ways:
 *   1. RESET: Reset the user's password to a new value and print it.
 *      After running, that printed value IS the user's password.
 *   2. CHECK: Test if a candidate password matches (without changing anything).
 *
 * Usage:
 *   node scripts/get-password-by-mobile.js <mobile>                    → Reset to new password and show it
 *   node scripts/get-password-by-mobile.js <mobile> <new_password>     → Set password to <new_password> and show it
 *   node scripts/get-password-by-mobile.js <mobile> --check <password> → Only check if <password> matches
 *
 * Examples:
 *   node scripts/get-password-by-mobile.js +919876543210
 *   node scripts/get-password-by-mobile.js 9876543210 12345678
 *   node scripts/get-password-by-mobile.js +919876543210 --check 12345678
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

function normalizeMobile(mobile) {
  let m = (mobile || '').trim().replace(/\s/g, '');
  if (!m) return '';
  if (m.startsWith('+')) return m;
  const digits = m.replace(/\D/g, '');
  if (digits.length === 10) return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  return m;
}

function randomPassword(length = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  const buf = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) s += chars[buf[i] % chars.length];
  return s;
}

async function run() {
  const args = process.argv.slice(2);
  const mobileRaw = args[0];
  if (!mobileRaw) {
    console.error('Usage:');
    console.error('  node scripts/get-password-by-mobile.js <mobile>');
    console.error('  node scripts/get-password-by-mobile.js <mobile> <new_password>');
    console.error('  node scripts/get-password-by-mobile.js <mobile> --check <password>');
    process.exit(1);
  }

  const mobile = normalizeMobile(mobileRaw);
  if (!mobile) {
    console.error('Invalid mobile number.');
    process.exit(1);
  }

  const isCheck = args[1] === '--check';
  const candidatePassword = isCheck ? args[2] : null;
  const explicitNewPassword = !isCheck && args[1] && args[1].trim().length > 0 ? args[1].trim() : null;

  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'orgit',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  try {
    await client.connect();
    console.log('Connected to', process.env.DB_NAME || 'orgit', 'at', process.env.DB_HOST);
    console.log('\nLooking for user with mobile:', mobile);

    const userResult = await client.query(
      `SELECT id, mobile, name, role, status, password_hash
       FROM users
       WHERE mobile = $1 OR REPLACE(mobile, ' ', '') = $1
       LIMIT 1`,
      [mobile]
    );

    if (userResult.rows.length === 0) {
      console.log('User not found for mobile:', mobile);
      process.exit(1);
    }

    const user = userResult.rows[0];
    console.log('\nUser found:');
    console.log('  ID:', user.id);
    console.log('  Name:', user.name);
    console.log('  Mobile:', user.mobile);
    console.log('  Role:', user.role);

    if (isCheck) {
      if (!candidatePassword) {
        console.error('For --check you must provide a password: --check <password>');
        process.exit(1);
      }
      if (!user.password_hash) {
        console.log('\nThis user has no password set. Nothing to check.');
        process.exit(0);
      }
      const matches = await bcrypt.compare(candidatePassword, user.password_hash);
      if (matches) {
        console.log('\nPassword matches. The user\'s current password is the one you provided.');
      } else {
        console.log('\nPassword does not match. The user\'s password is different.');
      }
      return;
    }

    // Reset/set password
    const newPassword = explicitNewPassword || randomPassword(10);
    const passwordHash = await bcrypt.hash(newPassword, 10);

    await client.query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [passwordHash, user.id]
    );

    console.log('\nPassword has been set for this user.');
    console.log('You can now use this as the user\'s password:\n');
    console.log('  ' + newPassword);
    console.log('');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
