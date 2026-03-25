import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { isSuperAdmin } from '../middleware/superAdminMiddleware';
import * as documentTemplateController from '../controllers/documentTemplateController';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Active templates route (accessible to all authenticated users)
router.get('/active', documentTemplateController.getActiveTemplates);
router.get('/:id', documentTemplateController.getDocumentTemplateById);

// Super admin only routes
router.use(isSuperAdmin);

// Document template CRUD
router.get('/', documentTemplateController.getAllDocumentTemplates);
router.post('/', documentTemplateController.createDocumentTemplate);
router.put('/:id', documentTemplateController.updateDocumentTemplate);
router.delete('/:id', documentTemplateController.deleteDocumentTemplate);

// Template versioning and preview
router.get('/:id/versions', documentTemplateController.getTemplateVersions);
router.post('/:id/preview', documentTemplateController.generatePreview);

export default router;

