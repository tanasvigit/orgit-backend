import { query } from '../config/database';
import { v4 as uuidv4 } from 'uuid';

export interface ContactInput {
  name: string;
  mobile: string;
}

/**
 * Sync contacts for a user
 */
export const syncContacts = async (
  userId: string,
  contacts: ContactInput[]
): Promise<void> => {
  // Start transaction
  const client = await query('BEGIN');

  try {
    // Delete existing contacts for this user
    await query('DELETE FROM contacts WHERE user_id = $1', [userId]);

    // Insert new contacts and check if they're registered users
    for (const contact of contacts) {
      // Check if mobile number belongs to a registered user
      const userResult = await query(
        'SELECT id FROM users WHERE mobile = $1',
        [contact.mobile]
      );

      const registeredUserId = userResult.rows.length > 0 ? userResult.rows[0].id : null;

      await query(
        `INSERT INTO contacts (id, user_id, name, mobile, is_registered, registered_user_id, synced_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())`,
        [userId, contact.name, contact.mobile, registeredUserId !== null, registeredUserId]
      );
    }

    await query('COMMIT');
  } catch (error) {
    await query('ROLLBACK');
    throw error;
  }
};

/**
 * Get synced contacts for a user
 */
export const getUserContacts = async (userId: string) => {
  const result = await query(
    `SELECT c.*, u.name as registered_name, u.profile_photo_url as registered_profile_photo
     FROM contacts c
     LEFT JOIN users u ON c.registered_user_id = u.id
     WHERE c.user_id = $1
     ORDER BY c.name ASC`,
    [userId]
  );

  return result.rows;
};

/**
 * Get registered users from contacts
 */
export const getRegisteredContacts = async (userId: string) => {
  const result = await query(
    `SELECT u.id, u.name, u.mobile, u.profile_photo_url, u.role, u.status
     FROM contacts c
     INNER JOIN users u ON c.registered_user_id = u.id
     WHERE c.user_id = $1 AND c.is_registered = true
     ORDER BY u.name ASC`,
    [userId]
  );

  return result.rows;
};

