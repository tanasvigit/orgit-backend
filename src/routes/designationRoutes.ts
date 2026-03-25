import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { isAdminOrSuperAdmin, requireOrganization } from '../middleware/adminMiddleware';
import * as designationController from '../controllers/designationController';

const router = Router();

// All routes require authentication and admin role
router.use(authenticate);
router.use(isAdminOrSuperAdmin);
router.use(requireOrganization);

// Designation CRUD
router.get('/', designationController.getDesignations);
router.post('/', designationController.createDesignation);
router.put('/:id', designationController.updateDesignation);
router.delete('/:id', designationController.deleteDesignation);

export default router;

