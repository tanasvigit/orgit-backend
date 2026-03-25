const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  try {
    const { name, phone, password, role } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({ error: 'Name, phone, and password are required' });
    }

    // Always create users as 'employee' during registration
    // Role can only be changed to 'admin' by super admin after registration
    const userRole = 'employee';

    // Check if user exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE phone = $1',
      [phone]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'User with this phone already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await pool.query(
      'INSERT INTO users (name, phone, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, phone, role, created_at',
      [name, phone, passwordHash, userRole]
    );

    const user = result.rows[0];

    // Create default profile record
    await pool.query(
      `INSERT INTO profiles (user_id, about, contact_number)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO NOTHING`,
      [
        user.id,
        'Hey there! I am using OrgIT.',
        phone,
      ]
    );

    // Check if user has an organization (only if they were added to one)
    // Do NOT create organization automatically
    // Organization will be created only when admin creates it in settings
    const orgResult = await pool.query(
      'SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1',
      [user.id]
    );
    const organizationId = orgResult.rows.length > 0 ? orgResult.rows[0].organization_id : null;

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, phone: user.phone, organizationId: organizationId },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      data: {
        token,
        refreshToken: token,
        user: {
          id: user.id,
          name: user.name,
          role: user.role || userRole,
          phone: user.phone,
          organizationId: organizationId || undefined,
          // Default profile info (can be updated later)
          about: 'Hey there! I am using OrgIT.',
          contact_number: phone,
          profile_photo: null,
        }
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone and password are required' });
    }

    // Find user with profile
    const result = await pool.query(
      `SELECT 
        u.id, 
        u.name, 
        u.role,
        u.phone, 
        u.password_hash,
        p.about,
        p.contact_number,
        p.profile_photo
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.phone = $1`,
      [phone]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      data: {
        token,
        refreshToken: token, // Assuming same for now as backend doesn't seem to have distinct refresh flow yet
        user: {
          id: user.id,
          name: user.name,
          role: user.role,
          phone: user.phone,
          about: user.about || 'Hey there! I am using OrgIT.',
          contact_number: user.contact_number || user.phone,
          profile_photo: user.profile_photo || null,
        }
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user (with profile)
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        u.id,
        u.name,
        u.role,
        u.phone,
        u.created_at,
        p.about,
        p.contact_number,
        p.profile_photo
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    res.json({
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        created_at: user.created_at,
        about: user.about || 'Hey there! I am using OrgIT.',
        contact_number: user.contact_number || user.phone,
        profile_photo: user.profile_photo || null,
      },
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update profile (about, contact_number, profile_photo)
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { name, about, contact_number, profile_photo } = req.body;

    await pool.query('BEGIN');

    // Optionally update name in users table
    if (name) {
      await pool.query(
        'UPDATE users SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [name, req.user.userId]
      );
    }

    // Upsert into profiles table
    const profileResult = await pool.query(
      `INSERT INTO profiles (user_id, about, contact_number, profile_photo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
       SET about = COALESCE($2, profiles.about),
           contact_number = COALESCE($3, profiles.contact_number),
           profile_photo = COALESCE($4, profiles.profile_photo),
           updated_at = CURRENT_TIMESTAMP
       RETURNING about, contact_number, profile_photo`,
      [req.user.userId, about || null, contact_number || null, profile_photo || null]
    );

    await pool.query('COMMIT');

    const profile = profileResult.rows[0];

    res.json({
      success: true,
      profile,
    });
  } catch (error) {
    await pool.query('ROLLBACK');
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get another user's profile by ID (for viewing recipient details)
// Register FCM push token for the current user (multi-device)
router.post('/push-token', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { token, platform } = req.body || {};
    if (!token || typeof token !== 'string' || !token.trim()) {
      return res.status(400).json({ error: 'token is required' });
    }
    const plat = (platform === 'ios' || platform === 'android') ? platform : 'android';
    await pool.query(
      `INSERT INTO user_push_tokens (user_id, token, platform, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, token) DO UPDATE SET platform = $3, updated_at = CURRENT_TIMESTAMP`,
      [userId, token.trim(), plat]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Push token registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove FCM push token (e.g. on logout)
router.delete('/push-token', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token is required' });
    }
    await pool.query(
      'DELETE FROM user_push_tokens WHERE user_id = $1 AND token = $2',
      [userId, token.trim()]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Push token delete error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/user/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      `SELECT 
        u.id,
        u.name,
        u.phone,
        p.about,
        p.contact_number,
        p.profile_photo
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    res.json({
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        about: user.about || 'Hey there! I am using OrgIT.',
        contact_number: user.contact_number || user.phone,
        profile_photo: user.profile_photo || null,
      },
    });
  } catch (error) {
    console.error('Get other user profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

