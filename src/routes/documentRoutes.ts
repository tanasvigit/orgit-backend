import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { isSuperAdmin } from '../middleware/superAdminMiddleware';
import * as documentController from '../controllers/documentController';
import { documentUpload } from '../services/documentService';

const router = Router();

// All routes require authentication
router.use(authenticate);

// List & detail – available to all authenticated roles (Super Admin, Admin, Employee)
router.get('/', documentController.getDocuments);
router.get('/:id', documentController.getDocumentById);

// Upload new document – ONLY Super Admin
router.post(
  '/',
  isSuperAdmin,
  documentUpload.single('file'),
  documentController.uploadDocument
);

// Update document content – Super Admin can edit all fields, Admin/Employee can only edit description
router.put(
  '/:id',
  authenticate, // All authenticated users can access, but permissions checked in service
  documentController.updateDocument
);

// Update status / delete – ONLY Super Admin
router.patch(
  '/:id/status',
  isSuperAdmin,
  documentController.updateDocumentStatus
);

router.delete(
  '/:id',
  isSuperAdmin,
  documentController.deleteDocument
);

export default router;


