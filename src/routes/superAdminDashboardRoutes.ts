import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { isSuperAdmin } from '../middleware/superAdminMiddleware';
import * as dashboardController from '../controllers/superAdminDashboardController';

const router = Router();

// All routes require authentication and super admin role
router.use(authenticate);
router.use(isSuperAdmin);

// Dashboard endpoints
router.get('/', dashboardController.getDashboardStatistics);
router.get('/organizations', dashboardController.getOrganizationMetrics);
router.get('/users', dashboardController.getUserMetrics);
router.get('/tasks', dashboardController.getTaskMetrics);

export default router;

