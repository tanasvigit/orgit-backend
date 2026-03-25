import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import * as userService from '../services/userService';

/**
 * Get all users (super admin only)
 */
export async function getAllUsers(req: AuthRequest, res: Response) {
  try {
    const filters = {
      role: req.query.role as string | undefined,
      status: req.query.status as string | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : 1,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : 20,
    };

    const result = await userService.getAllUsers(filters);

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error('Error getting users:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get users',
    });
  }
}

/**
 * Get user by ID
 */
export async function getUserById(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const user = await userService.getUserById(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.json({
      success: true,
      data: user,
    });
  } catch (error: any) {
    console.error('Error getting user:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get user',
    });
  }
}

/**
 * Delete user
 */
export async function deleteUser(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    
    // Prevent deleting yourself
    if (id === req.user?.userId) {
      return res.status(400).json({
        success: false,
        error: 'You cannot delete your own account',
      });
    }

    await userService.deleteUser(id);

    res.json({
      success: true,
      message: 'User deleted successfully',
    });
  } catch (error: any) {
    console.error('Error deleting user:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete user',
    });
  }
}

/**
 * Update user role (super admin only)
 */
export async function updateUserRole(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({
        success: false,
        error: 'Role is required',
      });
    }

    if (!['admin', 'employee', 'super_admin'].includes(role)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid role. Must be one of: admin, employee, super_admin',
      });
    }

    // Prevent changing own role
    if (id === req.user?.userId) {
      return res.status(400).json({
        success: false,
        error: 'Cannot change your own role',
      });
    }

    const { query } = await import('../config/database');
    
    // Get user details before updating
    const userResult = await query(
      'SELECT id, name, role FROM users WHERE id = $1',
      [id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const user = userResult.rows[0];
    const previousRole = user.role;

    // Update user role
    const result = await query(
      'UPDATE users SET role = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, name, role',
      [role, id]
    );

    // If role is being changed to 'admin', create an organization for them
    if (role === 'admin' && previousRole !== 'admin') {
      // Check if user already has an organization
      const existingOrg = await query(
        `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
        [id]
      );

      if (existingOrg.rows.length === 0) {
        // Create organization with user's registered name
        // This organization will be automatically updated when admin updates entity master data
        const orgResult = await query(
          `INSERT INTO organizations (id, name, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           RETURNING id, name`,
          [user.name || 'New Organization']
        );

        const organization = orgResult.rows[0];

        // Link admin to the organization
        await query(
          `INSERT INTO user_organizations (id, user_id, organization_id, created_at)
           VALUES (gen_random_uuid(), $1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT (user_id, organization_id) DO NOTHING`,
          [id, organization.id]
        );
      }
    }

    res.json({
      success: true,
      data: {
        message: 'Role updated successfully',
        user: result.rows[0],
      },
    });
  } catch (error: any) {
    console.error('Error updating user role:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update user role',
    });
  }
}

/**
 * Search users for chat (any authenticated user)
 */
export async function searchUsersForChat(req: AuthRequest, res: Response) {
  try {
    const search = (req.query.q as string) || '';
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const userRole = req.user?.role;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    if (!search || search.trim().length === 0) {
      return res.json({
        success: true,
        data: [],
      });
    }

    // Exclude super_admin users if current user is not super_admin
    const excludeSuperAdmin = userRole !== 'super_admin';

    // Global chat search:
    // - Any authenticated user can search any active user across organizations.
    // - Optionally exclude super_admin users for non-super_admin callers.
    // - Always exclude the requesting user to prevent self-chat.
    const users = await userService.searchUsersForChat(
      search,
      limit,
      excludeSuperAdmin,
      userId
    );

    return res.json({
      success: true,
      data: users,
    });
  } catch (error: any) {
    console.error('Error searching users for chat:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to search users',
    });
  }
}


