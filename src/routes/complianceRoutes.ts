import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { isAdminOrSuperAdmin, requireOrganization } from '../middleware/adminMiddleware';
import * as complianceController from '../controllers/complianceController';
import { upload } from '../services/complianceDocumentService';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Read routes (GET) - accessible by all authenticated users (Admin, Super Admin, Employee)
router.get('/', complianceController.getAllComplianceItems);
router.get('/categories', complianceController.getComplianceCategories);
router.get('/:id', complianceController.getComplianceItemById);
router.get('/:id/documents', complianceController.getComplianceDocuments);

// Write routes (POST, PUT, PATCH, DELETE) - require Admin/Super Admin role
router.use(isAdminOrSuperAdmin);
router.use(requireOrganization);

router.post('/', complianceController.createComplianceItem);
router.put('/:id', complianceController.updateComplianceItem);
router.patch('/:id/status', complianceController.updateComplianceStatus);
router.delete('/:id', complianceController.deleteComplianceItem);

// Document write routes (require Admin/Super Admin)
router.post('/:id/documents', upload.single('file'), complianceController.uploadComplianceDocument);
router.delete('/:id/documents/:docId', complianceController.deleteComplianceDocument);

export default router;
