const express = require('express');
const pool = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Helper function to normalize phone numbers
const normalizePhone = (phone) => {
  if (!phone) return null;
  // Remove all non-digit characters (spaces, dashes, parentheses, plus signs, etc.)
  let normalized = phone.toString().replace(/\D/g, '');
  
  // Handle different phone number formats
  // If it starts with country code (like 91 for India), remove it
  if (normalized.length === 12 && normalized.startsWith('91')) {
    normalized = normalized.slice(2);
  }
  // If it starts with 0 (like 09876543210), remove the leading 0
  if (normalized.length === 11 && normalized.startsWith('0')) {
    normalized = normalized.slice(1);
  }
  // Keep last 10 digits (handle any remaining country codes)
  if (normalized.length > 10) {
    normalized = normalized.slice(-10);
  }
  
  // Return only if it's exactly 10 digits
  return normalized.length === 10 ? normalized : null;
};

// Match device contacts with registered users (no database storage)
router.post('/match', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { contacts } = req.body; // Array of {name, phone}

    if (!Array.isArray(contacts)) {
      return res.status(400).json({ error: 'Contacts must be an array' });
    }

    console.log('Received contacts count:', contacts.length);

    // Extract and normalize phone numbers from device contacts
    // Handle both single phone and allPhones array
    const phoneNumbersSet = new Set();
    
    contacts.forEach((contact) => {
      if (contact.phone) {
        const normalized = normalizePhone(contact.phone);
        if (normalized) phoneNumbersSet.add(normalized);
      }
      // Also check allPhones if provided
      if (contact.allPhones && Array.isArray(contact.allPhones)) {
        contact.allPhones.forEach((phone) => {
          const normalized = normalizePhone(phone);
          if (normalized) phoneNumbersSet.add(normalized);
        });
      }
    });
    
    const phoneNumbers = Array.from(phoneNumbersSet);

    console.log('Normalized phone numbers count:', phoneNumbers.length);
    console.log('Sample phone numbers:', phoneNumbers.slice(0, 5));

    if (phoneNumbers.length === 0) {
      console.log('No valid phone numbers found in contacts');
      return res.json({ users: [] });
    }

    // Get user role to filter out super_admin users if needed
    const userRoleResult = await pool.query(
      `SELECT role FROM users WHERE id = $1`,
      [userId]
    );
    const userRole = userRoleResult.rows[0]?.role;

    // If user is not super_admin, exclude super_admin users from results
    const roleFilter = userRole === 'super_admin' 
      ? '' 
      : " AND role != 'super_admin'";

    // Get all users first to check their phone formats
    const allUsers = await pool.query(
      `SELECT id, name, phone, profile_photo, is_active
       FROM users
       WHERE is_active = TRUE AND id != $1${roleFilter}`,
      [userId]
    );

    console.log('Total active users in database:', allUsers.rows.length);
    console.log('Sample user phones:', allUsers.rows.slice(0, 5).map(u => u.phone));

    // Normalize database phone numbers and match
    const matchedUsers = allUsers.rows.filter((user) => {
      const normalizedDbPhone = normalizePhone(user.phone);
      return normalizedDbPhone && phoneNumbers.includes(normalizedDbPhone);
    });

    console.log('Matched users count:', matchedUsers.length);

    // Return matched users with original phone format
    const result = matchedUsers.map((user) => ({
      id: user.id,
      name: user.name,
      phone: user.phone,
      profile_photo: user.profile_photo,
      is_active: user.is_active,
    }));

    res.json({ users: result });
  } catch (error) {
    console.error('Match contacts error:', error);
    res.status(500).json({ error: 'Failed to match contacts' });
  }
});

module.exports = router;

