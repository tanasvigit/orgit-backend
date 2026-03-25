import { Response, NextFunction } from 'express';
import { AuthRequest } from './authMiddleware';
import { query } from '../config/database';

/**
 * Middleware to check if user is a super admin
 * Fetches role from database to ensure it's current (not from stale JWT)
 */
export const isSuperAdmin = async (req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
    });
  }

  try {
    // Fetch current role from database to ensure it's up-to-date
    const result = await query('SELECT role FROM users WHERE id = $1', [req.user.userId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const userRole = result.rows[0].role;

    if (userRole !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Super admin access required',
      });
    }

    // Update req.user.role with current database value
    req.user.role = userRole;

    next();
  } catch (error) {
    console.error('Super admin role check error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

