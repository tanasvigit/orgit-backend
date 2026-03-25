import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { isAdminOrSuperAdmin, requireOrganization } from '../middleware/adminMiddleware';
import * as controller from '../controllers/documentManagementSettingsController';

const router = Router();

router.use(authenticate);
router.use(isAdminOrSuperAdmin);
router.use(requireOrganization);

router.get('/', controller.getSettings);
router.put('/', controller.updateSettings);

export default router;

