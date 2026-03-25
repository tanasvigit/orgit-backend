import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { rateLimit } from '../middleware/rateLimitMiddleware';
import { searchUsersForChat } from '../controllers/userController';

const router = Router();

// Basic rate limiting to prevent abuse of chat user search
const chatSearchLimiter = rateLimit({
  windowMs: 60_000, // 1 minute window
  max: 30, // up to 30 searches per minute per IP/path
});

// GET /api/chat/users?q=...&limit=...
router.get('/', authenticate, chatSearchLimiter, searchUsersForChat);

export default router;


