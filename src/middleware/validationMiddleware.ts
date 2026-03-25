import { Request, Response, NextFunction } from 'express';
import { validationResult, ValidationChain } from 'express-validator';

/**
 * Middleware to run express-validator validationResult and return 400 with
 * first error message if validation failed. Call after validation chains.
 */
export function validateRequest(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const errors = validationResult(req);
  if (errors.isEmpty()) {
    next();
    return;
  }
  const firstError = errors.array({ formatter: (e) => e.msg })[0];
  res.status(400).json({
    success: false,
    error: firstError || 'Validation failed',
  });
}
