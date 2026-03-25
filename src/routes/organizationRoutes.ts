import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { isSuperAdmin } from '../middleware/superAdminMiddleware';
import * as organizationController from '../controllers/organizationController';

const router = Router();

// All routes require authentication and super admin role
router.use(authenticate);
router.use(isSuperAdmin);

// Organization CRUD
router.get('/', organizationController.getAllOrganizations);
router.get('/:id', organizationController.getOrganizationById);
router.post('/', organizationController.createOrganization);
router.put('/:id', organizationController.updateOrganization);

// Organization actions
router.post('/:id/suspend', organizationController.suspendOrganization);
router.post('/:id/activate', organizationController.activateOrganization);
router.delete('/:id', organizationController.deleteOrganization);

// Organization related data
router.get('/:id/users', organizationController.getOrganizationUsers);
router.get('/:id/tasks', organizationController.getOrganizationTasks);
router.get('/:id/stats', organizationController.getOrganizationStats);

export default router;

