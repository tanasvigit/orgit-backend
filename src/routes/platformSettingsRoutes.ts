import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { isSuperAdmin } from '../middleware/superAdminMiddleware';
import * as platformSettingsController from '../controllers/platformSettingsController';

const router = Router();

// All routes require authentication and super admin role
router.use(authenticate);
router.use(isSuperAdmin);

router.get('/', platformSettingsController.getAllSettings);
router.get('/:key', platformSettingsController.getSetting);
router.put('/auto-escalation', platformSettingsController.updateAutoEscalation);
router.put('/reminder', platformSettingsController.updateReminder);
router.put('/recurring-tasks', platformSettingsController.updateRecurringTasks);
router.put('/system', platformSettingsController.updateSystemSettings);

export default router;

