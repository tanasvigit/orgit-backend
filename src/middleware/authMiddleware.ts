import { Request, Response, NextFunction } from 'express';
import { verifyToken, JWTPayload } from '../utils/jwt';
import { query } from '../config/database';

export interface AuthRequest extends Request {
  user?: JWTPayload & {
    organizationId?: string;
  };
}

// In-memory cache to avoid hitting DB on every request (reduces load and timeouts under heavy chat traffic)
const ORG_CACHE_TTL_MS = parseInt(process.env.ORG_CACHE_TTL_MS || '300000', 10); // 5 minutes
const orgCache = new Map<string, { organizationId?: string; expiresAt: number }>();

/**
 * Authentication middleware
 */
export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'No token provided',
      });
    }

    const token = authHeader.substring(7);

    // Verify token (no session storage - token validation is sufficient)
    const decoded = verifyToken(token);

    // Get user's organizationId with cache (DB can be slow/unstable under load)
    const now = Date.now();
    const cached = orgCache.get(decoded.userId);
    let organizationId: string | undefined = undefined;

    if (cached && cached.expiresAt > now) {
      organizationId = cached.organizationId;
    } else {
      try {
        const orgResult = await query(
          `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
          [decoded.userId]
        );
        organizationId = orgResult.rows.length > 0 ? orgResult.rows[0].organization_id : undefined;
        orgCache.set(decoded.userId, { organizationId, expiresAt: now + ORG_CACHE_TTL_MS });
      } catch (dbErr) {
        // If DB lookup fails but we have a stale cached value, prefer using it to avoid 401 spam
        if (cached) {
          organizationId = cached.organizationId;
        } else {
          throw dbErr;
        }
      }
    }

    // Attach user info to request (organizationId fetched from DB, not from token)
    req.user = {
      ...decoded,
      organizationId,
    };

    next();
  } catch (error: any) {
    return res.status(401).json({
      success: false,
      error: error.message || 'Authentication failed',
    });
  }
};

/**
 * Role-based authorization middleware
 */
export const authorize = (...roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Insufficient permissions',
      });
    }

    next();
  };
};

/**
 * Helper function to check if user is super admin
 */
export const isSuperAdmin = (req: AuthRequest): boolean => {
  return req.user?.role === 'super_admin';
};

