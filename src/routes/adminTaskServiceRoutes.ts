import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { isAdminOrSuperAdmin, requireOrganization } from '../middleware/adminMiddleware';
import * as masterDataController from '../controllers/masterDataController';

const router = Router();

router.use(authenticate);
router.use(isAdminOrSuperAdmin);
router.use(requireOrganization);

router.post('/', masterDataController.createTaskService);

export default router;
