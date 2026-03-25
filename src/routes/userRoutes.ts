import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { isSuperAdmin } from '../middleware/superAdminMiddleware';
import * as userController from '../controllers/userController';

const router = Router();

// All routes require authentication and super admin role
router.use(authenticate);
router.use(isSuperAdmin);

// User management
router.get('/', userController.getAllUsers);
router.get('/:id', userController.getUserById);
router.put('/:id/role', userController.updateUserRole);
router.delete('/:id', userController.deleteUser);

export default router;

