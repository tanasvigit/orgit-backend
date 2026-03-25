import { Request, Response } from 'express';
import { query, getClient } from '../config/database';
import { generateToken, generateRefreshToken } from '../utils/jwt';
import { createOTPVerification, verifyOTP } from '../services/otpService';
import { syncContacts } from '../services/contactSyncService';
import { hashPassword, comparePassword } from '../utils/password';
import { validateName } from '../utils/nameValidation';

/**
 * Request OTP for registration/login
 */
export const requestOTP = async (req: Request, res: Response) => {
  try {
    const { mobile } = req.body;

    // Validate mobile number (basic check: must start with + and have at least a few digits)
    if (!mobile || !/^\+\d{6,20}$/.test(mobile)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid mobile number.',
      });
    }

    // Generate and send OTP
    const otpCode = await createOTPVerification(mobile);

    return res.json({
      success: true,
      message: 'OTP sent successfully',
      // In production, don't send OTP in response
      // For development/testing only:
      ...(process.env.NODE_ENV === 'development' && { otpCode }),
    });
  } catch (error: any) {
    console.error('Request OTP error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to send OTP',
    });
  }
};

/**
 * Verify OTP and create/login user
 */
export const verifyOTPAndLogin = async (req: Request, res: Response) => {
  try {
    const { mobile, otpCode, password, name } = req.body;

    console.log(`[verifyOTPAndLogin] Verifying OTP for ${mobile}, name: ${name || 'N/A'}`);

    // Validate inputs
    if (!mobile || !/^\+\d{6,20}$/.test(mobile)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid mobile number',
      });
    }

    if (!otpCode || !/^\d{6}$/.test(otpCode)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid OTP code. Must be 6 digits.',
      });
    }

    // Verify OTP
    await verifyOTP(mobile, otpCode);
    console.log(`[verifyOTPAndLogin] OTP verified for ${mobile}`);

    // Check if user exists
    let userResult = await query('SELECT * FROM users WHERE mobile = $1', [mobile]);

    let user;
    if (userResult.rows.length === 0) {
      console.log(`[verifyOTPAndLogin] Creating new user for ${mobile}`);

      // Use an explicit transaction so user creation is atomic and rolls back on failure.
      const client = await getClient();
      try {
        await client.query('BEGIN');

        let passwordHash = null;
        if (password) {
          // Hash password if provided during registration
          passwordHash = await hashPassword(password);
        }

        let userName = name ? (() => {
          const nameCheck = validateName(name);
          if (!nameCheck.valid) return `User ${mobile.slice(-4)}`;
          return nameCheck.sanitized!;
        })() : `User ${mobile.slice(-4)}`;

        const newUserResult = await client.query(
          `INSERT INTO users (id, mobile, name, role, status, password_hash)
           VALUES (gen_random_uuid(), $1, $2, 'employee', 'active', $3)
           RETURNING *`,
          [mobile, userName, passwordHash]
        );
        user = newUserResult.rows[0];
        console.log(`[verifyOTPAndLogin] New user created: ${user.id} (${user.name})`);

        // Create default profile entry for new user within the same transaction
        await client.query(
          `INSERT INTO profiles (user_id, about, contact_number, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (user_id) DO NOTHING`,
          [user.id, 'Hey there! I am using OrgIT.', mobile]
        );

        await client.query('COMMIT');
        console.log(`[verifyOTPAndLogin] Profile created for user: ${user.id}`);
      } catch (txError: any) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('[verifyOTPAndLogin] Failed to rollback transaction:', rollbackError);
        }
        console.error('[verifyOTPAndLogin] Transaction failed, no user created:', txError);
        throw txError;
      } finally {
        client.release();
      }
    } else {
      user = userResult.rows[0];
      console.log(`[verifyOTPAndLogin] User exists: ${user.id} (${user.name})`);

      // Ensure profile exists for existing user (in case it was created before profile table existed)
      try {
        await query(
          `INSERT INTO profiles (user_id, about, contact_number, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (user_id) DO NOTHING`,
          [user.id, 'Hey there! I am using OrgIT.', mobile]
        );
      } catch (profileError: any) {
        // Log but don't fail login if profile creation fails
        console.error(`[verifyOTPAndLogin] Failed to ensure profile exists for user ${user.id}:`, profileError);
      }

      // Update name if provided and valid (XSS-safe); use sanitized value for storage
      if (name && name !== user.name) {
        const nameCheck = validateName(name);
        if (nameCheck.valid && nameCheck.sanitized) {
          await query(
            `UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2`,
            [nameCheck.sanitized, user.id]
          );
          user.name = nameCheck.sanitized;
          console.log(`[verifyOTPAndLogin] Updated user name`);
        }
      }

      // If user exists and password is provided, update password hash
      if (password && !user.password_hash) {
        const passwordHash = await hashPassword(password);
        await query(
          `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
          [passwordHash, user.id]
        );
        user.password_hash = passwordHash;
        console.log(`[verifyOTPAndLogin] Updated user password`);
      }
    }

    // Check if user is active
    if (user.status !== 'active') {
      console.warn(`[verifyOTPAndLogin] User ${user.id} is not active: ${user.status}`);
      return res.status(403).json({
        success: false,
        error: 'User account is not active',
      });
    }

    // Get user's primary organization (for now, we'll create a default one if needed)
    let orgResult = await query(
      `SELECT uo.organization_id 
       FROM user_organizations uo 
       WHERE uo.user_id = $1 
       LIMIT 1`,
      [user.id]
    );

    let organizationId: string | undefined;
    if (orgResult.rows.length === 0) {
      // Create default organization for user (simplified - in production, admin should assign)
      const defaultOrgResult = await query(
        `INSERT INTO organizations (id, name) 
         VALUES (gen_random_uuid(), $1)
         RETURNING id`,
        [`Org ${mobile}`]
      );
      organizationId = defaultOrgResult.rows[0].id;

      await query(
        `INSERT INTO user_organizations (id, user_id, organization_id)
         VALUES (gen_random_uuid(), $1, $2)`,
        [user.id, organizationId]
      );
    } else {
      organizationId = orgResult.rows[0].organization_id;
    }

    // Generate tokens (no organizationId in token, stored in local storage on client)
    const token = generateToken({
      userId: user.id,
      mobile: user.mobile,
      role: user.role,
    });

    const refreshToken = generateRefreshToken({
      userId: user.id,
      mobile: user.mobile,
      role: user.role,
    });

    // No session storage in database - tokens stored in local storage on client

    return res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          mobile: user.mobile,
          name: user.name,
          role: user.role,
          status: user.status,
          profilePhotoUrl: user.profile_photo_url,
          bio: user.bio,
          organizationId: organizationId,
        },
        token,
        refreshToken,
        expiresIn: 7 * 24 * 60 * 60, // 7 days in seconds
      },
    });
  } catch (error: any) {
    console.error('Verify OTP error:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'OTP verification failed',
    });
  }
};

/**
 * Login with password
 */
export const loginWithPassword = async (req: Request, res: Response) => {
  const startTime = Date.now();
  console.log('='.repeat(80));
  console.log('[loginWithPassword] ========== LOGIN REQUEST RECEIVED ==========');
  console.log('[loginWithPassword] Timestamp:', new Date().toISOString());
  console.log('[loginWithPassword] Request body:', {
    mobile: req.body.mobile,
    password: req.body.password ? '***' : 'MISSING',
    deviceId: req.body.deviceId,
    deviceType: req.body.deviceType,
  });
  
  try {
    const { mobile, password } = req.body;

    if (!mobile || !password || password.trim().length === 0) {
      console.log('[loginWithPassword] ❌ VALIDATION FAILED: Missing mobile or password');
      return res.status(400).json({
        success: false,
        message: 'Mobile number and password are required.',
      });
    }

    // Normalize mobile: accept 10 digits, 12 digits starting with 91, or +91XXXXXXXXXX
    let mobileNorm = mobile.trim().replace(/\s/g, '');
    console.log('[loginWithPassword] Step 1: Mobile normalization');
    console.log('[loginWithPassword]   Input mobile:', mobile);
    console.log('[loginWithPassword]   After trim/space removal:', mobileNorm);
    if (mobileNorm.startsWith('+')) {
      mobileNorm = mobileNorm.replace(/\D/g, '').replace(/^(\d+)$/, '+$1');
    } else {
      const digits = mobileNorm.replace(/\D/g, '');
      if (digits.length === 10) {
        mobileNorm = '+91' + digits;
      } else if (digits.length === 12 && digits.startsWith('91')) {
        mobileNorm = '+' + digits;
      } else if (digits.length >= 6 && digits.length <= 20) {
        mobileNorm = '+91' + digits.slice(-10); // Take last 10 digits if longer
      } else {
        console.log('[loginWithPassword] Invalid format, digits length:', digits.length);
        return res.status(400).json({
          success: false,
          message: 'Invalid mobile number format.',
        });
      }
    }
    console.log('[loginWithPassword] Final normalized mobile:', mobileNorm);

    if (!/^\+\d{6,20}$/.test(mobileNorm)) {
      console.log('[loginWithPassword] ❌ VALIDATION FAILED: Invalid mobile format:', mobileNorm);
      return res.status(400).json({
        success: false,
        message: 'Invalid mobile number.',
      });
    }
    console.log('[loginWithPassword]   ✅ Final normalized mobile:', mobileNorm);

    // Find user by mobile - try multiple formats for maximum compatibility
    console.log('[loginWithPassword] Step 2: Database lookup');
    const digitsOnly = mobileNorm.replace(/\D/g, '');
    const last10Digits = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : digitsOnly;
    console.log('[loginWithPassword]   Extracted digits:', { digitsOnly, last10Digits });
    
    // Try exact match first
    console.log('[loginWithPassword]   Query 1: Exact match for:', mobileNorm);
    let userResult = await query(
      'SELECT * FROM users WHERE mobile = $1 OR REPLACE(mobile, \' \', \'\') = $1 LIMIT 1',
      [mobileNorm]
    );
    console.log('[loginWithPassword]   Query 1 result: ', userResult.rows.length > 0 ? '✅ FOUND' : '❌ NOT FOUND');
    if (userResult.rows.length > 0) {
      console.log('[loginWithPassword]   Found user:', {
        id: userResult.rows[0].id,
        mobile: userResult.rows[0].mobile,
        name: userResult.rows[0].name,
        hasPasswordHash: !!userResult.rows[0].password_hash,
        status: userResult.rows[0].status,
      });
    }
    
    // If not found, try matching by last 10 digits (handles any format: +9191XXXXXXXXXX, +919XXXXXXXXX, etc.)
    if (userResult.rows.length === 0 && last10Digits.length === 10) {
      console.log('[loginWithPassword]   Query 2: Fallback - match by last 10 digits:', last10Digits);
      
      // Strategy 1: Match mobile ending with these 10 digits (using SUBSTRING)
      userResult = await query(
        `SELECT * FROM users 
         WHERE SUBSTRING(REPLACE(REPLACE(mobile, ' ', ''), '+', '') FROM GREATEST(1, LENGTH(REPLACE(REPLACE(mobile, ' ', ''), '+', '')) - 9)) = $1
         LIMIT 1`,
        [last10Digits]
      );
      
      // Strategy 2: If still not found, try substring match (contains)
      if (userResult.rows.length === 0) {
        console.log('[loginWithPassword]   Query 3: Substring match (contains)');
        userResult = await query(
          `SELECT * FROM users 
           WHERE REPLACE(REPLACE(mobile, ' ', ''), '+', '') LIKE '%' || $1
           LIMIT 1`,
          [last10Digits]
        );
      }
      
      // Strategy 3: Try matching without + prefix (exact match)
      if (userResult.rows.length === 0) {
        console.log('[loginWithPassword]   Query 4: Match without + prefix');
        const mobileWithoutPlus = mobileNorm.replace('+', '');
        userResult = await query(
          `SELECT * FROM users 
           WHERE REPLACE(mobile, ' ', '') = $1 OR mobile = $1
           LIMIT 1`,
          [mobileWithoutPlus]
        );
      }
      
      // Strategy 4: Try matching the raw input (before normalization)
      if (userResult.rows.length === 0) {
        console.log('[loginWithPassword]   Query 5: Match raw input');
        const rawMobile = mobile.trim().replace(/\s/g, '');
        userResult = await query(
          `SELECT * FROM users 
           WHERE mobile = $1 OR REPLACE(mobile, ' ', '') = $1
           LIMIT 1`,
          [rawMobile]
        );
      }
      
      // Debug: Show similar mobiles in database for troubleshooting
      if (userResult.rows.length === 0) {
        console.log('[loginWithPassword]   DEBUG: Checking for similar mobiles in database...');
        const similarMobiles = await query(
          `SELECT mobile, name, id, status, 
                  CASE WHEN password_hash IS NOT NULL THEN 'YES' ELSE 'NO' END as has_password
           FROM users 
           WHERE REPLACE(REPLACE(mobile, ' ', ''), '+', '') LIKE '%' || $1 || '%'
           ORDER BY LENGTH(mobile) ASC
           LIMIT 10`,
          [last10Digits.slice(-4)] // Last 4 digits for broader search
        );
        if (similarMobiles.rows.length > 0) {
          console.log('[loginWithPassword]   Found similar mobiles in DB:');
          similarMobiles.rows.forEach((r: any, idx: number) => {
            console.log(`[loginWithPassword]     ${idx + 1}. Mobile: "${r.mobile}", Name: "${r.name}", Has Password: ${r.has_password}, Status: ${r.status}`);
          });
        } else {
          console.log('[loginWithPassword]   No similar mobiles found in database');
        }
      }
      
      console.log('[loginWithPassword]   Fallback queries result: ', userResult.rows.length > 0 ? '✅ FOUND' : '❌ NOT FOUND');
      if (userResult.rows.length > 0) {
        console.log('[loginWithPassword]   Found user:', {
          id: userResult.rows[0].id,
          mobile: userResult.rows[0].mobile,
          name: userResult.rows[0].name,
          hasPasswordHash: !!userResult.rows[0].password_hash,
          status: userResult.rows[0].status,
        });
      }
    }

    if (userResult.rows.length === 0) {
      console.log('[loginWithPassword] ❌ USER NOT FOUND');
      console.log('[loginWithPassword] Searched for:', { 
        originalMobile: mobile,
        normalizedMobile: mobileNorm, 
        last10Digits,
        digitsOnly 
      });
      
      // Additional debug: Check if user exists with any variation
      const allUsersCheck = await query(
        `SELECT COUNT(*) as total FROM users WHERE status = 'active'`
      );
      console.log('[loginWithPassword]   Total active users in database:', allUsersCheck.rows[0]?.total || 0);
      
      const elapsed = Date.now() - startTime;
      console.log('[loginWithPassword] Request completed in', elapsed, 'ms');
      console.log('='.repeat(80));
      return res.status(401).json({
        success: false,
        message: 'Invalid mobile or password.',
      });
    }

    const user = userResult.rows[0];
    console.log('[loginWithPassword] Step 3: User validation');
    console.log('[loginWithPassword]   User ID:', user.id);
    console.log('[loginWithPassword]   User mobile:', user.mobile);
    console.log('[loginWithPassword]   User name:', user.name);
    console.log('[loginWithPassword]   User status:', user.status);

    // Check if user has password set
    if (!user.password_hash) {
      console.log('[loginWithPassword] ❌ PASSWORD NOT SET for user');
      const elapsed = Date.now() - startTime;
      console.log('[loginWithPassword] Request completed in', elapsed, 'ms');
      console.log('='.repeat(80));
      return res.status(401).json({
        success: false,
        message: 'Invalid mobile or password.',
      });
    }
    console.log('[loginWithPassword]   ✅ Password hash exists');

    // Verify password
    console.log('[loginWithPassword] Step 4: Password verification');
    console.log('[loginWithPassword]   Provided password length:', password.length);
    console.log('[loginWithPassword]   Provided password (first 2 chars):', password.substring(0, 2) + '***');
    console.log('[loginWithPassword]   Password hash (first 20 chars):', user.password_hash?.substring(0, 20) + '...');
    console.log('[loginWithPassword]   Password hash length:', user.password_hash?.length);
    console.log('[loginWithPassword]   Comparing provided password with hash...');
    
    const isPasswordValid = await comparePassword(password, user.password_hash);
    console.log('[loginWithPassword]   Password comparison result:', isPasswordValid);
    
    if (!isPasswordValid) {
      console.log('[loginWithPassword] ❌ PASSWORD MISMATCH');
      console.log('[loginWithPassword]   Possible reasons:');
      console.log('[loginWithPassword]     - Wrong password entered');
      console.log('[loginWithPassword]     - Password hash mismatch in database');
      console.log('[loginWithPassword]     - Password was changed/reset');
      console.log('[loginWithPassword]   Expected default password for bulk-uploaded users: 12345678');
      
      // Try to verify if this might be a bulk-uploaded user
      const isBulkUser = user.must_change_password === true;
      if (isBulkUser) {
        console.log('[loginWithPassword]   ⚠️  User has must_change_password=true (likely bulk-uploaded)');
        console.log('[loginWithPassword]   ⚠️  Default password should be: 12345678');
      }
      
      const elapsed = Date.now() - startTime;
      console.log('[loginWithPassword] Request completed in', elapsed, 'ms');
      console.log('='.repeat(80));
      return res.status(401).json({
        success: false,
        message: 'Invalid mobile or password.',
      });
    }

    // Check if user is active
    console.log('[loginWithPassword] Step 5: User status check');
    console.log('[loginWithPassword]   User status:', user.status);
    if (user.status !== 'active') {
      console.log('[loginWithPassword] ❌ USER ACCOUNT NOT ACTIVE');
      const elapsed = Date.now() - startTime;
      console.log('[loginWithPassword] Request completed in', elapsed, 'ms');
      console.log('='.repeat(80));
      return res.status(403).json({
        success: false,
        error: 'User account is not active',
      });
    }
    console.log('[loginWithPassword]   ✅ User is active');

    // Check if user has an organization (only if they were added to one)
    console.log('[loginWithPassword] Step 6: Organization check');
    let orgResult = await query(
      `SELECT uo.organization_id 
       FROM user_organizations uo 
       WHERE uo.user_id = $1 
       LIMIT 1`,
      [user.id]
    );

    // Do NOT create organization automatically during login
    // Organization will be created only when:
    // 1. Super admin changes user role to 'admin' (creates org with user's registered name)
    // 2. Admin creates/updates organization through entity master data
    const organizationId: string | undefined = orgResult.rows.length > 0 
      ? orgResult.rows[0].organization_id 
      : undefined;
    console.log('[loginWithPassword]   Organization ID:', organizationId || 'None');

    // Generate tokens (no organizationId in token, stored in local storage on client)
    console.log('[loginWithPassword] Step 7: Generating tokens');
    const token = generateToken({
      userId: user.id,
      mobile: user.mobile,
      role: user.role,
    });

    const refreshToken = generateRefreshToken({
      userId: user.id,
      mobile: user.mobile,
      role: user.role,
    });
    console.log('[loginWithPassword]   ✅ Tokens generated');

    // No session storage in database - tokens stored in local storage on client

    const mustChangePassword = !!user.must_change_password;
    console.log('[loginWithPassword]   Must change password:', mustChangePassword);

    console.log('[loginWithPassword] Step 8: Sending success response');
    const elapsed = Date.now() - startTime;
    console.log('[loginWithPassword] ✅ LOGIN SUCCESS');
    console.log('[loginWithPassword] Request completed in', elapsed, 'ms');
    console.log('[loginWithPassword] User:', {
      id: user.id,
      mobile: user.mobile,
      name: user.name,
      role: user.role,
      mustChangePassword,
    });
    console.log('='.repeat(80));

    return res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          mobile: user.mobile,
          name: user.name,
          role: user.role,
          status: user.status,
          profilePhotoUrl: user.profile_photo_url,
          bio: user.bio,
          organizationId: organizationId,
          mustChangePassword,
        },
        token,
        refreshToken,
        expiresIn: 7 * 24 * 60 * 60, // 7 days in seconds
        mustChangePassword,
      },
    });
  } catch (error: any) {
    const elapsed = Date.now() - startTime;
    console.error('[loginWithPassword] ❌❌❌ EXCEPTION OCCURRED ❌❌❌');
    console.error('[loginWithPassword] Error:', error);
    console.error('[loginWithPassword] Error message:', error.message);
    console.error('[loginWithPassword] Error stack:', error.stack);
    console.error('[loginWithPassword] Request failed after', elapsed, 'ms');
    console.log('='.repeat(80));
    return res.status(500).json({
      success: false,
      message: 'Login failed. Please try again later.',
    });
  }
};

/**
 * Update user profile (about, contact_number, profile_photo)
 * Uses profiles table for extended profile data
 */
export const setupProfile = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const { name, profilePhotoUrl, bio, about, contact_number, profile_photo } = req.body;

    // Start transaction
    await query('BEGIN');

    try {
      // Optionally update name in users table (XSS-safe: validate and store sanitized only)
      if (name && typeof name === 'string' && name.trim().length > 0) {
        const nameCheck = validateName(name);
        if (nameCheck.valid && nameCheck.sanitized) {
          await query(
            'UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2',
            [nameCheck.sanitized, userId]
          );
        }
      }

      // Use profile_photo if provided, otherwise profilePhotoUrl
      const photoUrl = profile_photo || profilePhotoUrl || null;
      // Use about if provided, otherwise bio
      const userBio = about || bio || null;

      // Upsert into profiles table
      const profileResult = await query(
        `INSERT INTO profiles (user_id, about, contact_number, profile_photo, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE
         SET about = COALESCE($2, profiles.about),
             contact_number = COALESCE($3, profiles.contact_number),
             profile_photo = COALESCE($4, profiles.profile_photo),
             updated_at = NOW()
         RETURNING about, contact_number, profile_photo`,
        [userId, userBio || null, contact_number || null, photoUrl || null]
      );

      // Commit transaction
      await query('COMMIT');

      const profile = profileResult.rows[0] || {};

      return res.json({
        success: true,
        profile: {
          about: profile.about || null,
          contact_number: profile.contact_number || null,
          profile_photo: profile.profile_photo || null,
        },
      });
    } catch (error: any) {
      // Rollback transaction on error
      await query('ROLLBACK');
      throw error;
    }
  } catch (error: any) {
    console.error('Update profile error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to update profile',
    });
  }
};

/**
 * Register new user (for mobile app compatibility)
 */
export const register = async (req: Request, res: Response) => {
  try {
    const { name, phone, password } = req.body;

    const nameCheck = validateName(name);
    if (!nameCheck.valid) {
      return res.status(400).json({
        success: false,
        error: nameCheck.error || 'Invalid name',
      });
    }
    const safeName = nameCheck.sanitized!;

    if (!phone || !/^\+\d{6,20}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid mobile number. Must be in international format (e.g., +911234567890)',
      });
    }

    if (!password || password.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Password is required',
      });
    }

    // Always create users as 'employee' during registration
    // Role can only be changed to 'admin' by super admin after registration
    const userRole = 'employee';

    // Use an explicit transaction so registration is atomic.
    const client = await getClient();
    let user;
    try {
      await client.query('BEGIN');

      // Check if user already exists inside the transaction to avoid race conditions
      const existingUser = await client.query('SELECT id FROM users WHERE mobile = $1', [phone]);
      if (existingUser.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'User with this mobile number already exists',
        });
      }

      // Hash password
      const passwordHash = await hashPassword(password);

      // Create user (store only sanitized name to prevent stored XSS)
      const userResult = await client.query(
        `INSERT INTO users (id, mobile, name, role, status, password_hash)
         VALUES (gen_random_uuid(), $1, $2, $3, 'active', $4)
         RETURNING id, mobile, name, role, status, profile_photo_url, bio, created_at`,
        [phone, safeName, userRole, passwordHash]
      );

      user = userResult.rows[0];

      // Create default profile entry for new user
      await client.query(
        `INSERT INTO profiles (user_id, about, contact_number, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (user_id) DO NOTHING`,
        [user.id, 'Hey there! I am using OrgIT.', phone]
      );

      await client.query('COMMIT');
      console.log(`[register] User and profile created for user: ${user.id}`);
    } catch (txError: any) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('[register] Failed to rollback transaction:', rollbackError);
      }
      console.error('[register] Registration transaction failed, no user created:', txError);
      throw txError;
    } finally {
      client.release();
    }

    // Check if user has an organization (only if they were added to one)
    let orgResult = await query(
      `SELECT uo.organization_id 
       FROM user_organizations uo 
       WHERE uo.user_id = $1 
       LIMIT 1`,
      [user.id]
    );

    // Do NOT create organization automatically
    // Organization will be created only when admin creates it in settings
    const organizationId: string | undefined = orgResult.rows.length > 0 
      ? orgResult.rows[0].organization_id 
      : undefined;

    // Generate tokens (no organizationId in token, stored in local storage on client)
    const token = generateToken({
      userId: user.id,
      mobile: user.mobile,
      role: user.role,
    });

    generateRefreshToken({
      userId: user.id,
      mobile: user.mobile,
      role: user.role,
    });

    // No session storage in database - tokens stored in local storage on client

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        mobile: user.mobile,
        name: user.name,
        role: user.role,
        status: user.status,
        profilePhotoUrl: user.profile_photo_url,
        bio: user.bio,
        organizationId: organizationId || undefined,
      },
    });
  } catch (error: any) {
    console.error('Register error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Registration failed',
    });
  }
};

/**
 * Get user by ID (for viewing recipient details)
 * Joins with profiles table to get extended profile data
 */
export const getUserById = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const userRole = (req as any).user?.role;
    const { userId: targetUserId } = req.params;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    // NOTE: Organization-based visibility is intentionally not enforced here so that
    // any authenticated user can view basic profile information for another user
    // (e.g., for messaging/contact cards). Access is still restricted to
    // authenticated callers via the authenticate middleware.

    const result = await query(
      `SELECT 
        u.id,
        u.name,
        u.mobile,
        p.about,
        p.contact_number,
        u.profile_photo_url
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1 AND (u.status = 'active' OR u.status IS NULL)`,
      [targetUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const user = result.rows[0];
    
    // Resolve profile photo URL if it's an S3 key
    const photoValue = user.profile_photo_url || null;
    const { resolveToUrl } = require('../services/s3StorageService');
    const resolvedPhotoUrl = photoValue ? resolveToUrl(photoValue) || photoValue : null;

    return res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        phone: user.mobile,
        about: user.about || 'Hey there! I am using OrgIT.',
        contact_number: user.contact_number || user.mobile,
        profile_photo: resolvedPhotoUrl,
        profile_photo_url: resolvedPhotoUrl,
      },
    });
  } catch (error: any) {
    console.error('Get user by ID error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get user',
    });
  }
};

/**
 * Sync contacts
 */
export const syncUserContacts = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const { contacts } = req.body;

    if (!Array.isArray(contacts)) {
      return res.status(400).json({
        success: false,
        error: 'Contacts must be an array',
      });
    }

    // Validate contacts format
    const validContacts = contacts.filter(
      (c: any) => c.name && c.mobile && /^\d{10}$/.test(c.mobile)
    );

    await syncContacts(userId, validContacts);

    return res.json({
      success: true,
      message: 'Contacts synced successfully',
    });
  } catch (error: any) {
    console.error('Sync contacts error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to sync contacts',
    });
  }
};

/**
 * Get current user profile (with profile data from profiles table)
 */
export const getCurrentUser = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const result = await query(
      `SELECT 
        u.id,
        u.name,
        u.mobile,
        u.role,
        u.status,
        u.created_at,
        u.must_change_password,
        p.about,
        p.contact_number,
        u.profile_photo_url,
        u.bio
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const userRow = result.rows[0];

    // Get user's organization ID
    const orgResult = await query(
      `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    const organizationId = orgResult.rows[0]?.organization_id || null;

    const mustChangePassword = !!userRow.must_change_password;

    // Resolve profile photo URL if it's an S3 key
    const photoValue = userRow.profile_photo_url || null;
    const { resolveToUrl } = require('../services/s3StorageService');
    const resolvedPhotoUrl = photoValue ? resolveToUrl(photoValue) || photoValue : null;

    // Format response to match frontend User interface
    return res.json({
      success: true,
      data: {
        id: userRow.id,
        mobile: userRow.mobile,
        phone: userRow.mobile,
        name: userRow.name,
        role: userRow.role,
        status: userRow.status,
        profilePhotoUrl: resolvedPhotoUrl || undefined,
        profile_photo: resolvedPhotoUrl || null,
        profile_photo_url: resolvedPhotoUrl || null,
        bio: userRow.bio || undefined,
        about: userRow.about || userRow.bio || undefined,
        contact_number: userRow.contact_number || userRow.mobile || undefined,
        organizationId: organizationId || undefined,
        mustChangePassword,
      },
    });
  } catch (error: any) {
    console.error('Get current user error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get user',
    });
  }
};

/**
 * Change password (authenticated). Clears must_change_password on success.
 */
export const changePassword = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword || newPassword.trim().length < 4) {
      return res.status(400).json({
        success: false,
        error: 'Current password and new password (min 4 characters) are required',
      });
    }
    const r = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (r.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const valid = await comparePassword(currentPassword, r.rows[0].password_hash);
    if (!valid) {
      return res.status(400).json({ success: false, error: 'Current password is incorrect' });
    }
    const passwordHash = await hashPassword(newPassword.trim());
    await query(
      'UPDATE users SET password_hash = $1, must_change_password = false, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [passwordHash, userId]
    );
    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (error: any) {
    console.error('Change password error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to change password',
    });
  }
};

/**
 * Dismiss change-password prompt (Skip). Sets must_change_password = false.
 */
export const dismissChangePassword = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    await query(
      'UPDATE users SET must_change_password = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
      [userId]
    );
    return res.json({ success: true, message: 'Dismissed' });
  } catch (error: any) {
    console.error('Dismiss change password error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to dismiss',
    });
  }
};

/**
 * Register FCM push token for the current user (multi-device). Used for chat push notifications.
 */
export const registerPushToken = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const { token, platform } = req.body || {};
    if (!token || typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ error: 'token is required' });
    }
    const plat = platform === 'ios' || platform === 'android' ? platform : 'android';
    console.log('Registered push token:', { userId, token: token.trim(), platform: plat });

    // Ensure user exists in users table (avoids FK violation if JWT user was deleted or from another DB)
    const userCheck = await query('SELECT id FROM users WHERE id = $1', [userId]);
    if (!userCheck.rows.length) {
      return res.status(404).json({
        success: false,
        error: 'User not found. Re-login may be required.',
      });
    }

    // Keep only the latest token per user+platform to avoid stale/NotRegistered tokens
    // This prevents old tokens (from re-installs or other devices) from lingering forever.
    await query(
      `DELETE FROM user_push_tokens
       WHERE user_id = $1 AND platform = $2 AND token <> $3`,
      [userId, plat, token.trim()]
    );

    await query(
      `INSERT INTO user_push_tokens (user_id, token, platform, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, token)
       DO UPDATE SET platform = $3, updated_at = NOW()`,
      [userId, token.trim(), plat]
    );
    return res.json({ success: true });
  } catch (error: any) {
    console.error('Push token registration error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Remove FCM push token (e.g. on logout).
 */
export const deletePushToken = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token is required' });
    }
    await query(
      'DELETE FROM user_push_tokens WHERE user_id = $1 AND token = $2',
      [userId, token.trim()]
    );
    return res.json({ success: true });
  } catch (error: any) {
    console.error('Push token delete error:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Normalize mobile to international format (+91...) for lookup. Reused for forgot/reset password.
 */
function normalizeMobileForLookup(mobile: string): string | null {
  if (!mobile || typeof mobile !== 'string') return null;
  let mobileNorm = mobile.trim().replace(/\s/g, '');
  if (mobileNorm.startsWith('+')) {
    mobileNorm = mobileNorm.replace(/\D/g, '').replace(/^(\d+)$/, '+$1');
  } else {
    const digits = mobileNorm.replace(/\D/g, '');
    if (digits.length === 10) mobileNorm = '+91' + digits;
    else if (digits.length === 12 && digits.startsWith('91')) mobileNorm = '+' + digits;
    else if (digits.length >= 6 && digits.length <= 20) mobileNorm = '+91' + digits.slice(-10);
    else return null;
  }
  return /^\+\d{6,20}$/.test(mobileNorm) ? mobileNorm : null;
}

/**
 * Find user by normalized mobile (exact then last-10-digits match). Returns user row or null.
 */
async function findUserByMobile(normalizedMobile: string): Promise<any | null> {
  const last10 = normalizedMobile.replace(/\D/g, '').slice(-10);
  let r = await query(
    "SELECT * FROM users WHERE mobile = $1 OR REPLACE(mobile, ' ', '') = $1 LIMIT 1",
    [normalizedMobile]
  );
  if (r.rows.length > 0) return r.rows[0];
  if (last10.length === 10) {
    r = await query(
      `SELECT * FROM users WHERE REPLACE(REPLACE(mobile, ' ', ''), '+', '') LIKE '%' || $1 LIMIT 1`,
      [last10]
    );
    if (r.rows.length > 0) return r.rows[0];
  }
  return null;
}

/**
 * Forgot password (OTP-based, no email). Sends OTP to mobile; always returns generic success.
 */
export const requestPasswordReset = async (req: Request, res: Response) => {
  try {
    const { mobile } = req.body || {};
    const mobileNorm = normalizeMobileForLookup(mobile);
    if (!mobileNorm) {
      return res.status(400).json({
        success: false,
        error: 'Valid mobile number is required (e.g. 10 digits or +91...)',
      });
    }
    let otpCode: string | undefined;
    const user = await findUserByMobile(mobileNorm);
    if (user && user.status === 'active') {
      otpCode = await createOTPVerification(mobileNorm);
    }
    const payload: Record<string, unknown> = {
      success: true,
      message: 'If an account exists for this number, an OTP has been sent. Use it on the next screen to set a new password.',
    };
    if (process.env.NODE_ENV === 'development' && otpCode) {
      payload.otpCode = otpCode;
      console.log(`[requestPasswordReset] OTP for ${mobileNorm}: ${otpCode} (returned in dev response)`);
    }
    return res.status(200).json(payload);
  } catch (error: any) {
    console.error('Request password reset error:', error);
    return res.status(200).json({
      success: true,
      message: 'If an account exists for this number, an OTP has been sent. Use it on the next screen to set a new password.',
    });
  }
};

/**
 * Reset password with OTP (no email). Verifies OTP then sets new password.
 */
export const resetPasswordWithOTP = async (req: Request, res: Response) => {
  try {
    const { mobile, otpCode, newPassword } = req.body || {};
    const mobileNorm = normalizeMobileForLookup(mobile);
    if (!mobileNorm) {
      return res.status(400).json({
        success: false,
        error: 'Valid mobile number is required',
      });
    }
    if (!otpCode || !/^\d{6}$/.test(String(otpCode).trim())) {
      return res.status(400).json({
        success: false,
        error: 'Valid 6-digit OTP is required',
      });
    }
    if (!newPassword || String(newPassword).trim().length < 4) {
      return res.status(400).json({
        success: false,
        error: 'New password must be at least 4 characters',
      });
    }
    await verifyOTP(mobileNorm, String(otpCode).trim());
    const user = await findUserByMobile(mobileNorm);
    if (!user) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired OTP. Please request a new one.',
      });
    }
    const passwordHash = await hashPassword(String(newPassword).trim());
    await query(
      'UPDATE users SET password_hash = $1, must_change_password = false, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [passwordHash, user.id]
    );
    return res.json({
      success: true,
      message: 'Password has been reset successfully. You can now log in with your new password.',
    });
  } catch (error: any) {
    console.error('Reset password with OTP error:', error);
    const msg = error?.message || '';
    if (msg.includes('OTP') || msg.includes('expired') || msg.includes('Invalid') || msg.includes('Maximum')) {
      return res.status(400).json({
        success: false,
        error: error.message || 'Invalid or expired OTP. Please request a new one.',
      });
    }
    return res.status(500).json({
      success: false,
      error: 'Failed to reset password. Please try again.',
    });
  }
};