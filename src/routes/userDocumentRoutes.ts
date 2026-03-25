import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import {
  listUserDocuments,
  createUserDoc,
  getUserDoc,
  downloadUserDoc,
  uploadUserDocumentPDF,
  createTaskFromUserDocument,
  deleteUserDoc,
} from '../controllers/userDocumentController';
import { documentUpload } from '../services/mediaUploadService';

const router = Router();

router.use(authenticate);

router.post('/upload-pdf', documentUpload.single('file'), (req, res, next) => {
  uploadUserDocumentPDF(req as any, res).catch(next);
});

router.post('/', createUserDoc);
router.get('/', listUserDocuments);
router.get('/:id', getUserDoc);
router.get('/:id/download', downloadUserDoc);
router.post('/:id/create-task', createTaskFromUserDocument);
router.delete('/:id', deleteUserDoc);

export default router;
