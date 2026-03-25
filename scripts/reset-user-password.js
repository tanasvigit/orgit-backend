/**
 * Script to reset a user's password to the default bulk-upload password (12345678)
 * Usage: node scripts/reset-user-password.js <mobile_number>
 * Example: node scripts/reset-user-password.js +919000902069
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const DEFAULT_PASSWORD = '12345678';

async function resetPassword(mobile) {
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
    
    console.log(`\n🔍 Looking for user with mobile: ${mobile}`);
    
    // Normalize mobile
    let mobileNorm = mobile.trim().replace(/\s/g, '');
    if (!mobileNorm.startsWith('+')) {
      const digits = mobileNorm.replace(/\D/g, '');
      if (digits.length === 10) {
        mobileNorm = '+91' + digits;
      } else if (digits.length === 12 && digits.startsWith('91')) {
        mobileNorm = '+' + digits;
      }
    }
    
    console.log(`📱 Normalized mobile: ${mobileNorm}`);
    
    // Find user
    const userResult = await client.query(
      'SELECT id, mobile, name, role, status, password_hash IS NOT NULL as has_password FROM users WHERE mobile = $1 OR REPLACE(mobile, \' \', \'\') = $1 LIMIT 1',
      [mobileNorm]
    );
    
    if (userResult.rows.length === 0) {
      console.log('❌ User not found!');
      return;
    }
    
    const user = userResult.rows[0];
    console.log(`\n✅ User found:`);
    console.log(`   ID: ${user.id}`);
    console.log(`   Name: ${user.name}`);
    console.log(`   Mobile: ${user.mobile}`);
    console.log(`   Role: ${user.role}`);
    console.log(`   Status: ${user.status}`);
    console.log(`   Has Password: ${user.has_password}`);
    
    // Hash new password
    console.log(`\n🔐 Hashing new password: ${DEFAULT_PASSWORD}`);
    const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
    
    // Update password only (avoid must_change_password if column doesn't exist)
    await client.query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [passwordHash, user.id]
    );
    
    console.log(`\n✅ Password reset successfully!`);
    console.log(`   New password: ${DEFAULT_PASSWORD}`);
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    throw error;
  } finally {
    await client.end();
  }
}

// Get mobile from command line
const mobile = process.argv[2];

if (!mobile) {
  console.error('❌ Usage: node scripts/reset-user-password.js <mobile_number>');
  console.error('   Example: node scripts/reset-user-password.js +919000902069');
  process.exit(1);
}

resetPassword(mobile)
  .then(() => {
    console.log('\n✨ Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Failed:', error);
    process.exit(1);
  });
