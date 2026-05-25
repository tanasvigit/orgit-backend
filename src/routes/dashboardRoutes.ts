import { Router } from 'express';
import { getDashboard, getStatistics, getMonthlyCalendar, getDashboardEvents, postDashboardEvent } from '../controllers/dashboardController';
import { authenticate } from '../middleware/authMiddleware';
import { requireModule } from '../middleware/employeePermissionMiddleware';
import { query as queryValidator } from 'express-validator';

const router = Router();

// All routes require authentication
router.use(authenticate);
router.use(requireModule('Dashboard'));

router.get(
  '/',
  [
    queryValidator('dueSoonDays').optional().isInt({ min: 1, max: 30 }),
  ],
  getDashboard
);

router.get('/statistics', getStatistics);
router.get('/calendar', getMonthlyCalendar);
router.get('/events', getDashboardEvents);
router.post('/events', postDashboardEvent);

export default router;

