import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { isAdminOrSuperAdmin, requireOrganization } from '../middleware/adminMiddleware';
import * as clientEntityController from '../controllers/clientEntityController';

const router = Router();

router.use(authenticate);
router.use(isAdminOrSuperAdmin);
router.use(requireOrganization);

// Basic CRUD
router.get('/', clientEntityController.getClientEntities);
router.post('/', clientEntityController.createClientEntity);
router.put('/:id', clientEntityController.updateClientEntity);
router.delete('/:id', clientEntityController.deleteClientEntity);

// Matrix + per-client services update
router.get('/matrix', clientEntityController.getClientServiceMatrix);
router.put('/:id/services', clientEntityController.upsertClientServices);

export default router;

