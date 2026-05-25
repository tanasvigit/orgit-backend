import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import {
  requireModule,
  requireDocumentRight,
  requireGeneralRight,
  requireTaskRight,
} from '../middleware/employeePermissionMiddleware';
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
router.use(requireModule('Documents'));

router.post(
  '/upload-pdf',
  requireDocumentRight('upload'),
  documentUpload.single('file'),
  (req, res, next) => {
    uploadUserDocumentPDF(req as any, res).catch(next);
  }
);

router.post('/', requireDocumentRight('upload'), createUserDoc);
router.get('/', requireDocumentRight('view'), listUserDocuments);
router.get('/:id', requireDocumentRight('view'), getUserDoc);
router.get('/:id/download', requireDocumentRight('download'), downloadUserDoc);
router.post('/:id/create-task', requireTaskRight('createTask'), createTaskFromUserDocument);
router.delete('/:id', requireGeneralRight('delete'), deleteUserDoc);

export default router;
