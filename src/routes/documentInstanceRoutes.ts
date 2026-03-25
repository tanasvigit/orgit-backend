import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import {
  createInstance,
  getInstances,
  getInstanceById,
  updateInstance,
  deleteInstance,
  downloadInstance,
  markInstanceChecked,
  markInstanceApproved,
  createTaskFromDocument,
  uploadDocumentPDF,
} from '../controllers/documentInstanceController';
import { documentUpload } from '../services/mediaUploadService';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Upload PDF for document instance (uses document-pdfs/ prefix)
// Must be before /:id routes to avoid route conflicts
router.post('/upload-pdf', documentUpload.single('file'), (req, res, next) => {
  console.log('[documentInstanceRoutes] POST /upload-pdf route hit');
  uploadDocumentPDF(req as any, res).catch(next);
});

// Create document instance
router.post('/', createInstance);

// Get document instances (with filters)
router.get('/', getInstances);

// Get document instance by ID
router.get('/:id', getInstanceById);

// Create task from document (after PDF generated)
router.post('/:id/create-task', createTaskFromDocument);

// Update document instance
router.put('/:id', updateInstance);

// Delete/archive document instance
router.delete('/:id', deleteInstance);

// Download PDF
router.get('/:id/download', downloadInstance);

// Approval flow actions
router.post('/:id/mark-checked', markInstanceChecked);
router.post('/:id/mark-approved', markInstanceApproved);

export default router;

