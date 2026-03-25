#!/usr/bin/env node

/**
 * Super Admin Assignment Script
 * 
 * This script allows you to assign the super_admin role to a user by their mobile number.
 * It uses environment variables for database connection, making it reusable across different databases.
 * 
 * Usage:
 *   node assign-super-admin.js
 * 
 * Required Environment Variables:
 *   DB_HOST (default: localhost)
 *   DB_PORT (default: 5432)
 *   DB_NAME (default: orgit)
 *   DB_USER (default: postgres)
 *   DB_PASSWORD (default: postgres)
 * 
 * Or create a .env file in the same directory with these variables.
 */

const { Pool } = require('pg');
const readline = require('readline');
require('dotenv').config();

// Database configuration from environment variables
const poolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'orgit',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
};

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

/**
 * Prompt user for input
 */
function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Validate mobile number format (accepts +, country codes, etc.)
 */
function isValidMobileNumber(mobile) {
  // Remove any spaces, dashes, or parentheses (keep +)
  const cleaned = mobile.replace(/[\s\-\(\)]/g, '');
  // Check if it's a valid mobile number (with or without +, 10-15 digits)
  return /^\+?\d{10,15}$/.test(cleaned);
}

/**
 * Normalize mobile number and generate possible formats to search
 * Handles: 9652824932, 919652824932, +919652824932
 */
function getMobileNumberVariants(mobile) {
  const cleaned = mobile.replace(/[\s\-\(\)]/g, '');
  const variants = [];
  
  // If it starts with +, use as is
  if (cleaned.startsWith('+')) {
    variants.push(cleaned);
    // Also try without +
    variants.push(cleaned.substring(1));
  } else {
    // If it's 10 digits (Indian number without country code)
    if (/^\d{10}$/.test(cleaned)) {
      variants.push(cleaned); // 9652824932
      variants.push('+91' + cleaned); // +919652824932
      variants.push('91' + cleaned); // 919652824932
    }
    // If it's 12 digits starting with 91 (Indian number with country code)
    else if (/^91\d{10}$/.test(cleaned)) {
      variants.push(cleaned); // 919652824932
      variants.push('+91' + cleaned.substring(2)); // +919652824932
      variants.push(cleaned.substring(2)); // 9652824932
      variants.push('+' + cleaned); // +919652824932
    }
    // If it's 13 digits starting with 919 (already has country code)
    else if (/^919\d{10}$/.test(cleaned)) {
      variants.push(cleaned); // 919652824932
      variants.push('+' + cleaned); // +919652824932
      variants.push(cleaned.substring(2)); // 9652824932
    }
    // Otherwise, use as is and try with +
    else {
      variants.push(cleaned);
      if (!cleaned.startsWith('+')) {
        variants.push('+' + cleaned);
      }
    }
  }
  
  // Remove duplicates
  return [...new Set(variants)];
}

/**
 * Main function to assign super_admin role
 */
async function assignSuperAdmin() {
  let pool;
  
  try {
    console.log('Connecting to database...');
    console.log(`Database: ${poolConfig.database} on ${poolConfig.host}:${poolConfig.port}`);
    
    // Create database connection pool
    pool = new Pool(poolConfig);
    
    // Test connection
    await pool.query('SELECT NOW()');
    console.log('✓ Database connected successfully\n');
    
    // Prompt for mobile number
    const mobileNumber = await prompt('Enter mobile number to assign super_admin role: ');
    
    if (!mobileNumber) {
      console.error('❌ Error: Mobile number cannot be empty');
      process.exit(1);
    }
    
    // Basic validation
    if (!isValidMobileNumber(mobileNumber)) {
      console.error('❌ Error: Invalid mobile number format. Please enter a valid mobile number.');
      process.exit(1);
    }
    
    // Get all possible variants of the mobile number
    const mobileVariants = getMobileNumberVariants(mobileNumber);
    console.log(`\nSearching for mobile number variants: ${mobileVariants.join(', ')}`);
    
    // Check if user exists (try all variants)
    console.log('Checking if user exists...');
    const userCheck = await pool.query(
      `SELECT id, name, mobile, role, status FROM users WHERE mobile = ANY($1::text[])`,
      [mobileVariants]
    );
    
    if (userCheck.rows.length === 0) {
      console.error(`❌ Error: User with mobile number "${mobileNumber}" not found in database.`);
      console.error(`   Tried formats: ${mobileVariants.join(', ')}`);
      console.error('   Please make sure the user is registered first.');
      process.exit(1);
    }
    
    const user = userCheck.rows[0];
    const actualMobileNumber = user.mobile; // Use the actual mobile number from database
    console.log(`✓ User found: ${user.name} (Mobile: ${actualMobileNumber}, Current role: ${user.role}, Status: ${user.status})`);
    
    // Check if already super_admin
    if (user.role === 'super_admin') {
      console.log(`\n⚠️  User "${user.name}" already has super_admin role.`);
      const confirm = await prompt('Do you want to continue anyway? (y/n): ');
      if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
        console.log('Operation cancelled.');
        process.exit(0);
      }
    }
    
    // Update user role to super_admin (use the actual mobile number from database)
    console.log('\nUpdating user role...');
    const updateResult = await pool.query(
      `UPDATE users 
       SET role = 'super_admin', updated_at = NOW() 
       WHERE mobile = $1 
       RETURNING id, name, mobile, role, updated_at`,
      [actualMobileNumber]
    );
    
    if (updateResult.rows.length === 0) {
      console.error('❌ Error: Failed to update user role.');
      process.exit(1);
    }
    
    const updatedUser = updateResult.rows[0];
    console.log('\n✅ Success!');
    console.log(`   User: ${updatedUser.name}`);
    console.log(`   Mobile: ${updatedUser.mobile}`);
    console.log(`   Role: ${updatedUser.role}`);
    console.log(`   Updated at: ${new Date(updatedUser.updated_at).toLocaleString()}`);
    
  } catch (error) {
    console.error('\n❌ Error occurred:');
    
    if (error.code === 'ECONNREFUSED') {
      console.error('   Database connection refused. Please check:');
      console.error(`   - Database is running on ${poolConfig.host}:${poolConfig.port}`);
      console.error('   - Connection credentials are correct');
    } else if (error.code === '28P01') {
      console.error('   Authentication failed. Please check your database credentials.');
    } else if (error.code === '3D000') {
      console.error(`   Database "${poolConfig.database}" does not exist.`);
    } else {
      console.error(`   ${error.message}`);
      if (process.env.NODE_ENV === 'development') {
        console.error('\nStack trace:');
        console.error(error.stack);
      }
    }
    
    process.exit(1);
  } finally {
    // Close database connection
    if (pool) {
      await pool.end();
      console.log('\n✓ Database connection closed.');
    }
    
    // Close readline interface
    rl.close();
  }
}

// Run the script
if (require.main === module) {
  assignSuperAdmin().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
  });
}

module.exports = { assignSuperAdmin };

