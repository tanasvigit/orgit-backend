import { Router } from 'express';
import { getDashboard, getStatistics } from '../controllers/dashboardController';
import { authenticate } from '../middleware/authMiddleware';
import { query as queryValidator } from 'express-validator';

const router = Router();

// All routes require authentication
router.use(authenticate);

router.get(
  '/',
  [
    queryValidator('dueSoonDays').optional().isInt({ min: 1, max: 30 }),
  ],
  getDashboard
);

router.get('/statistics', getStatistics);

export default router;

