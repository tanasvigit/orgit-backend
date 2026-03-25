import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authMiddleware';
import { isAdminOrSuperAdmin, requireOrganization } from '../middleware/adminMiddleware';
import * as taskBulkController from '../controllers/taskBulkController';

const router = Router();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const name = (file.originalname || '').toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files (.xlsx, .xls) are allowed'));
    }
  },
});

router.use(authenticate);
router.use(isAdminOrSuperAdmin);
router.use(requireOrganization);

router.get('/template', taskBulkController.getTemplate);
router.get('/status/:uploadId', taskBulkController.getStatus);
router.post('/upload', upload.single('file'), taskBulkController.upload);

export default router;
