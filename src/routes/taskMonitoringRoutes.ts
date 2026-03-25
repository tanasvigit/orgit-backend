import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { isSuperAdmin } from '../middleware/superAdminMiddleware';
import * as taskMonitoringController from '../controllers/taskMonitoringController';

const router = Router();

// All routes require authentication and super admin role
router.use(authenticate);
router.use(isSuperAdmin);

// Task monitoring endpoints
router.get('/monitoring', taskMonitoringController.getTaskAnalytics);
router.get('/monitoring/:organizationId', taskMonitoringController.getOrganizationTaskAnalytics);
router.get('/overdue', taskMonitoringController.getOverdueTasks);
router.get('/statistics', taskMonitoringController.getPlatformTaskStatistics);

export default router;

