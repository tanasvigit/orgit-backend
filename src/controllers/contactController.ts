import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import { query } from '../config/database';

/**
 * Helper function to normalize phone numbers - matching message-backend
 */
const normalizePhone = (phone: string | null | undefined): string | null => {
  if (!phone) return null;
  // Remove all non-digit characters (spaces, dashes, parentheses, plus signs, etc.)
  let normalized = phone.toString().replace(/\D/g, '');

  if (normalized.length === 0) return null;

  // Handle different phone number formats
  // If it starts with country code (like 91 for India), remove it
  if (normalized.length >= 12 && normalized.startsWith('91')) {
    normalized = normalized.slice(2);
  }
  // If it starts with 0 (like 09876543210), remove the leading 0
  if (normalized.length >= 11 && normalized.startsWith('0')) {
    normalized = normalized.slice(1);
  }
  // Keep last 10 digits (handle any remaining country codes)
  if (normalized.length > 10) {
    normalized = normalized.slice(-10);
  }

  // Return last 10 digits (allow 10-12 digits for flexibility)
  return normalized.length >= 10 ? normalized.slice(-10) : null;
};

/**
 * Match device contacts with registered users (no database storage) - matching message-backend
 */
export const matchContacts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { contacts } = req.body; // Array of {name, phone}

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!Array.isArray(contacts)) {
      return res.status(400).json({ error: 'Contacts must be an array' });
    }

    console.log('Received contacts count:', contacts.length);

    // Extract and normalize phone numbers from device contacts
    // Handle both single phone and allPhones array
    const phoneNumbersSet = new Set<string>();

    contacts.forEach((contact: any) => {
      if (contact.phone) {
        const normalized = normalizePhone(contact.phone);
        if (normalized) phoneNumbersSet.add(normalized);
      }
      // Also check allPhones if provided
      if (contact.allPhones && Array.isArray(contact.allPhones)) {
        contact.allPhones.forEach((phone: string) => {
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
    const userResult = await query(
      `SELECT role FROM users WHERE id = $1`,
      [userId]
    );
    const userRole = userResult.rows[0]?.role;

    // If user is not super_admin, exclude super_admin users from results
    const roleFilter = userRole === 'super_admin' 
      ? '' 
      : " AND u.role != 'super_admin'";

    // Get all users first to check their phone formats
    // Updated query to match the actual database schema
    const allUsers = await query(
      `SELECT u.id, u.name, u.mobile as phone, 
              u.profile_photo_url as profile_photo, 
              (u.status = 'active') as is_active
       FROM users u
       WHERE u.status = 'active' AND u.id != $1${roleFilter}`,
      [userId]
    );


    console.log('Total active users in database:', allUsers.rows.length);
    console.log('Sample user phones (raw):', allUsers.rows.slice(0, 5).map((u: any) => u.phone));
    console.log('Sample user phones (normalized):', allUsers.rows.slice(0, 5).map((u: any) => normalizePhone(u.phone)));
    console.log('Sample contact phones (normalized):', phoneNumbers.slice(0, 10));

    // Normalize database phone numbers and match
    // Also try matching with different normalization strategies
    const matchedUsers = allUsers.rows.filter((user: any) => {
      if (!user.phone) return false;

      // Try multiple normalization strategies
      const normalizedDbPhone = normalizePhone(user.phone);
      if (normalizedDbPhone && phoneNumbers.includes(normalizedDbPhone)) {
        return true;
      }

      // Also try matching last 10 digits directly (for numbers with country codes)
      const dbPhoneDigits = user.phone.toString().replace(/\D/g, '');
      if (dbPhoneDigits.length >= 10) {
        const last10Digits = dbPhoneDigits.slice(-10);
        if (phoneNumbers.includes(last10Digits)) {
          return true;
        }
      }

      // Try matching without normalization (exact match after removing non-digits)
      const contactPhoneDigits = phoneNumbers.map(p => p.replace(/\D/g, ''));
      if (contactPhoneDigits.some(cp => dbPhoneDigits.includes(cp) || cp.includes(dbPhoneDigits))) {
        return true;
      }

      return false;
    });

    console.log('Matched users count:', matchedUsers.length);
    console.log('Sample matched users:', matchedUsers.slice(0, 3).map((u: any) => ({ id: u.id, name: u.name, phone: u.phone })));

    // Return matched users with original phone format
    const result = matchedUsers.map((user: any) => ({
      id: user.id,
      name: user.name,
      phone: user.phone,
      profile_photo: user.profile_photo,
      is_active: user.is_active,
    }));

    res.json({ users: result });
  } catch (error: any) {
    console.error('Match contacts error:', error);
    console.error('Error details:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to match contacts', details: error.message });
  }
};
