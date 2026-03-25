import { Router } from 'express';
import {
  requestOTP,
  verifyOTPAndLogin,
  loginWithPassword,
  setupProfile,
  syncUserContacts,
  getCurrentUser,
  register,
  getUserById,
  changePassword,
  dismissChangePassword,
  registerPushToken,
  deletePushToken,
  requestPasswordReset,
  resetPasswordWithOTP,
} from '../controllers/authController';
import { authenticate } from '../middleware/authMiddleware';
import { validateRequest } from '../middleware/validationMiddleware';
import { body, param } from 'express-validator';
import { validateName } from '../utils/nameValidation';

/** Express-validator custom: reject name if invalid (XSS / invalid chars / length). */
const nameValidator = (value: string) => {
  const result = validateName(value);
  if (!result.valid) throw new Error(result.error);
  return true;
};

/** Optional name: if present, must pass name validation. */
const optionalNameValidator = (value: string | undefined) => {
  if (value === undefined || value === null || String(value).trim() === '') return true;
  const result = validateName(value);
  if (!result.valid) throw new Error(result.error);
  return true;
};

const router = Router();

// Public routes
router.post(
  '/request-otp',
  [
    body('mobile')
      .matches(/^\+\d{6,20}$/)
      .withMessage('Mobile number must be in international format (e.g., +911234567890)'),
  ],
  validateRequest,
  requestOTP
);

router.post(
  '/verify-otp',
  [
    body('mobile')
      .matches(/^\+\d{6,20}$/)
      .withMessage('Mobile number must be in international format (e.g., +911234567890)'),
    body('otpCode')
      .isLength({ min: 6, max: 6 })
      .withMessage('OTP must be 6 digits')
      .isNumeric()
      .withMessage('OTP must be numeric'),
    body('name').optional({ values: 'falsy' }).trim().custom(optionalNameValidator),
  ],
  validateRequest,
  verifyOTPAndLogin
);

router.post(
  '/login',
  [
    body('mobile')
      .matches(/^\+\d{6,20}$/)
      .withMessage('Mobile number must be in international format (e.g., +911234567890)'),
    body('password')
      .trim()
      .isLength({ min: 1 })
      .withMessage('Password is required'),
  ],
  validateRequest,
  loginWithPassword
);

// Forgot password (OTP-based, no email): send OTP to mobile
router.post(
  '/password/forgot',
  [
    body('mobile')
      .trim()
      .notEmpty()
      .withMessage('Mobile number is required'),
  ],
  validateRequest,
  requestPasswordReset
);

// Reset password with OTP
router.post(
  '/password/reset',
  [
    body('mobile').trim().notEmpty().withMessage('Mobile number is required'),
    body('otpCode')
      .trim()
      .isLength({ min: 6, max: 6 })
      .withMessage('OTP must be 6 digits')
      .isNumeric()
      .withMessage('OTP must be numeric'),
    body('newPassword')
      .trim()
      .isLength({ min: 4 })
      .withMessage('New password must be at least 4 characters'),
  ],
  validateRequest,
  resetPasswordWithOTP
);

// Register endpoint for mobile app (name: XSS-safe, 2-50 chars, letters/spaces/hyphens/apostrophes only)
router.post(
  '/register',
  [
    body('name')
      .trim()
      .isLength({ min: 1 })
      .withMessage('Name is required')
      .custom(nameValidator),
    body('phone')
      .matches(/^\+\d{6,20}$/)
      .withMessage('Mobile number must be in international format (e.g., +911234567890)'),
    body('password')
      .trim()
      .isLength({ min: 1 })
      .withMessage('Password is required'),
    body('role')
      .optional()
      .isIn(['admin', 'employee'])
      .withMessage('Role must be either admin or employee'),
  ],
  validateRequest,
  register
);

// Protected routes
router.get('/me', authenticate, getCurrentUser);

router.get(
  '/user/:userId',
  authenticate,
  [param('userId').isUUID().withMessage('userId must be a valid UUID')],
  validateRequest,
  getUserById
);

router.put(
  '/profile',
  authenticate,
  [
    body('name')
      .optional({ values: 'falsy' })
      .trim()
      .custom(optionalNameValidator),
  ],
  validateRequest,
  setupProfile
);

router.post(
  '/contacts/sync',
  authenticate,
  [
    body('contacts')
      .isArray()
      .withMessage('Contacts must be an array'),
    body('contacts.*.name')
      .trim()
      .isLength({ min: 1 })
      .withMessage('Contact name is required'),
    body('contacts.*.mobile')
      .isLength({ min: 10, max: 10 })
      .withMessage('Contact mobile must be 10 digits')
      .isNumeric()
      .withMessage('Contact mobile must be numeric'),
  ],
  validateRequest,
  syncUserContacts
);

router.put(
  '/change-password',
  authenticate,
  [
    body('currentPassword').trim().notEmpty().withMessage('Current password is required'),
    body('newPassword').trim().isLength({ min: 4 }).withMessage('New password must be at least 4 characters'),
  ],
  validateRequest,
  changePassword
);

router.post('/dismiss-change-password', authenticate, dismissChangePassword);

// FCM push token (for chat push notifications)
router.post('/push-token', authenticate, registerPushToken);
router.delete('/push-token', authenticate, deletePushToken);

export default router;

