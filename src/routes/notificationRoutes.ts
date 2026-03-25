import { Router } from 'express';
import {
  getNotifications,
  markAsReadHandler,
  markAllAsReadHandler,
  deleteNotificationHandler,
} from '../controllers/notificationController';
import { authenticate } from '../middleware/authMiddleware';
import { query as queryValidator } from 'express-validator';

const router = Router();

// All routes require authentication
router.use(authenticate);

router.get(
  '/',
  [
    queryValidator('limit').optional().isInt({ min: 1, max: 100 }),
    queryValidator('unreadOnly').optional().isBoolean(),
  ],
  getNotifications
);

router.post('/:notificationId/read', markAsReadHandler);

router.post('/read-all', markAllAsReadHandler);

router.delete('/:notificationId', deleteNotificationHandler);

export default router;

