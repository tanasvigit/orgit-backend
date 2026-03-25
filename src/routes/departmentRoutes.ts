import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { isAdminOrSuperAdmin, requireOrganization } from '../middleware/adminMiddleware';
import * as departmentController from '../controllers/departmentController';

const router = Router();

// All routes require authentication and admin role
router.use(authenticate);
router.use(isAdminOrSuperAdmin);
router.use(requireOrganization);

// Department CRUD
router.get('/', departmentController.getDepartments);
router.post('/', departmentController.createDepartment);
router.put('/:id', departmentController.updateDepartment);
router.delete('/:id', departmentController.deleteDepartment);

export default router;

