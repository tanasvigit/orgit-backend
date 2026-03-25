import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { requireOrganization } from '../middleware/adminMiddleware';
import * as clientEntityController from '../controllers/clientEntityController';

const router = Router();

// Organization-scoped client/entity endpoints for all org members (not admin-only).
// These routes are read-only and always scoped to the current user's organization.
router.use(authenticate);
router.use(requireOrganization);

// Client + service matrix for task create (all org members).
// GET /api/organization/entities/matrix
router.get('/matrix', clientEntityController.getClientServiceMatrix);

export default router;

