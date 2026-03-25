import { query } from '../config/database';
import pool from '../config/database';

/**
 * Get all users (for super admin)
 */
export async function getAllUsers(filters: {
  role?: string;
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
} = {}) {
  const {
    role,
    status,
    search,
    page = 1,
    limit = 20,
  } = filters;

  let whereConditions: string[] = [];
  const queryParams: any[] = [];
  let paramIndex = 1;

  if (role) {
    whereConditions.push(`role = $${paramIndex++}`);
    queryParams.push(role);
  }

  if (status) {
    whereConditions.push(`status = $${paramIndex++}`);
    queryParams.push(status);
  }

  if (search) {
    whereConditions.push(`(name ILIKE $${paramIndex} OR mobile ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`);
    queryParams.push(`%${search}%`);
    paramIndex++;
  }

  const whereClause = whereConditions.length > 0
    ? `WHERE ${whereConditions.join(' AND ')}`
    : '';

  const offset = (page - 1) * limit;

  // Get total count
  const countResult = await query(
    `SELECT COUNT(*) as total FROM users ${whereClause}`,
    queryParams
  );
  const total = parseInt(countResult.rows[0].total, 10);

  // Get users
  const result = await query(
    `SELECT 
      id, mobile, name, role, status, profile_photo_url, bio,
      created_at, updated_at
    FROM users 
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...queryParams, limit, offset]
  );

  return {
    users: result.rows.map(row => ({
      id: row.id,
      mobile: row.mobile,
      name: row.name,
      role: row.role,
      status: row.status,
      profilePhotoUrl: row.profile_photo_url,
      bio: row.bio,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    })),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get user by ID
 */
export async function getUserById(id: string) {
  const result = await query(
    'SELECT id, mobile, name, role, status, profile_photo_url, bio, created_at, updated_at FROM users WHERE id = $1',
    [id]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    mobile: row.mobile,
    name: row.name,
    role: row.role,
    status: row.status,
    profilePhotoUrl: row.profile_photo_url,
    bio: row.bio,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Delete user and all related data
 */
export async function deleteUser(id: string): Promise<boolean> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Delete user_organizations relationships
    await client.query(
      'DELETE FROM user_organizations WHERE user_id = $1',
      [id]
    );
    
    // Delete group memberships
    await client.query(
      'DELETE FROM group_members WHERE user_id = $1',
      [id]
    );
    
    // Delete messages sent by user
    await client.query(
      'DELETE FROM messages WHERE sender_id = $1',
      [id]
    );
    
    // Delete message status records
    await client.query(
      'DELETE FROM message_status WHERE user_id = $1',
      [id]
    );
    
    // Delete task assignments
    await client.query(
      'DELETE FROM task_assignments WHERE user_id = $1',
      [id]
    );
    
    // Delete tasks created by user (or reassign - for now we'll delete)
    await client.query(
      'DELETE FROM tasks WHERE creator_id = $1',
      [id]
    );
    
    // Delete notifications
    await client.query(
      'DELETE FROM notifications WHERE user_id = $1',
      [id]
    );
    
    // Delete contacts
    await client.query(
      'DELETE FROM contacts WHERE user_id = $1',
      [id]
    );
    
    // Delete sessions
    await client.query(
      'DELETE FROM sessions WHERE user_id = $1',
      [id]
    );
    
    // Delete OTP verifications
    await client.query(
      'DELETE FROM otp_verifications WHERE mobile = (SELECT mobile FROM users WHERE id = $1)',
      [id]
    );
    
    // Finally delete the user
    await client.query(
      'DELETE FROM users WHERE id = $1',
      [id]
    );
    
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Search users by name or mobile (for messaging).
 * - Global across all organizations.
 * - Can optionally exclude super_admin users.
 * - Can optionally exclude a specific user (e.g. the requester) to prevent self-chat.
 */
export async function searchUsersForChat(
  search: string,
  limit: number = 20,
  excludeSuperAdmin: boolean = true,
  excludeUserId?: string
) {
  if (!search || search.trim().length === 0) {
    return [];
  }

  const whereConditions: string[] = ["status = 'active'"];
  const params: any[] = [];
  let paramIndex = 1;

  // Match by name or mobile
  whereConditions.push(`(mobile ILIKE $${paramIndex} OR name ILIKE $${paramIndex})`);
  params.push(`%${search}%`);
  paramIndex++;

  // Optionally exclude super_admin users
  if (excludeSuperAdmin) {
    whereConditions.push("role != 'super_admin'");
  }

  // Optionally exclude a specific user (typically the requesting user)
  if (excludeUserId) {
    whereConditions.push(`id != $${paramIndex}`);
    params.push(excludeUserId);
    paramIndex++;
  }

  const queryText = `
    SELECT 
      id, mobile, name, role, status, profile_photo_url, bio
    FROM users
    WHERE ${whereConditions.join(' AND ')}
    ORDER BY name ASC
    LIMIT $${paramIndex}
  `;

  const result = await query(queryText, [...params, limit]);

  return result.rows.map((row) => ({
    id: row.id,
    mobile: row.mobile,
    name: row.name,
    role: row.role,
    status: row.status,
    profilePhotoUrl: row.profile_photo_url,
    bio: row.bio,
  }));
}

/**
 * Search users for chat that are in the same organization(s) as the current user.
 * - Restricts visibility to users who share at least one organization with currentUserId.
 * - Excludes super_admin users when excludeSuperAdmin is true.
 */
export async function searchUsersForChatInSameOrganizations(
  search: string,
  limit: number = 20,
  excludeSuperAdmin: boolean = true,
  currentUserId: string
) {
  if (!search || search.trim().length === 0) {
    return [];
  }

  const roleFilter = excludeSuperAdmin ? " AND u.role != 'super_admin'" : '';

  const result = await query(
    `SELECT 
      u.id,
      u.mobile,
      u.name,
      u.role,
      u.status,
      u.profile_photo_url,
      p.profile_photo
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.id
     WHERE u.status = 'active'
       AND u.id != $3
       AND EXISTS (
         SELECT 1
         FROM user_organizations uo1
         JOIN user_organizations uo2 ON uo1.organization_id = uo2.organization_id
         WHERE uo1.user_id = $3 AND uo2.user_id = u.id
       )
       AND (u.mobile ILIKE $1 OR u.name ILIKE $1)${roleFilter}
     ORDER BY u.name ASC
     LIMIT $2`,
    [`%${search}%`, limit, currentUserId]
  );

  // Resolve profile photo URL if it's an S3 key or stored path
  const { resolveToUrl } = require('./s3StorageService');

  return result.rows.map((row: any) => {
    const rawPhoto = row.profile_photo_url || row.profile_photo || null;
    const resolvedPhoto =
      rawPhoto != null ? resolveToUrl(rawPhoto) || rawPhoto : null;

    return {
      id: row.id,
      mobile: row.mobile,
      name: row.name,
      role: row.role,
      status: row.status,
      profilePhotoUrl: resolvedPhoto,
    };
  });
}



