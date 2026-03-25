import { Router } from 'express';
import { matchContacts } from '../controllers/contactController';
import { authenticate } from '../middleware/authMiddleware';
import { body } from 'express-validator';

const router = Router();

// All routes require authentication
router.use(authenticate);

// POST /api/contacts/match - Match device contacts with registered users
router.post(
  '/match',
  [
    body('contacts')
      .isArray()
      .withMessage('Contacts must be an array'),
    body('contacts.*.mobile')
      .optional()
      .isString()
      .withMessage('Contact mobile must be a string'),
  ],
  matchContacts
);

export default router;

