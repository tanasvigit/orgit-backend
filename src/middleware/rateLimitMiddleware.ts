import type { Request, Response, NextFunction } from 'express';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  /**
   * Optional custom key generator. Defaults to IP + route path.
   */
  keyGenerator?: (req: Request) => string;
}

interface RateLimitEntry {
  count: number;
  expiresAt: number;
}

// Simple in-memory store keyed by a string (e.g., IP + path)
const store = new Map<string, RateLimitEntry>();

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, max, keyGenerator } = options;

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const key =
      keyGenerator?.(req) ??
      `${req.ip || req.connection.remoteAddress || 'unknown'}:${req.baseUrl}${req.path}`;

    const existing = store.get(key);

    if (!existing || existing.expiresAt <= now) {
      // New window
      store.set(key, { count: 1, expiresAt: now + windowMs });
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(max - 1));
      return next();
    }

    if (existing.count >= max) {
      const retryAfterSeconds = Math.ceil((existing.expiresAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', '0');

      return res.status(429).json({
        success: false,
        error: 'Too many requests, please try again later.',
      });
    }

    existing.count += 1;
    store.set(key, existing);

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(max - existing.count, 0)));

    return next();
  };
}

