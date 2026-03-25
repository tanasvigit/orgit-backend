import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/authMiddleware';
import { isAdminOrSuperAdmin, requireOrganization } from '../middleware/adminMiddleware';
import * as entityMasterBulkController from '../controllers/entityMasterBulkController';

const router = Router();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
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

router.get('/template', entityMasterBulkController.getTemplate);
router.get('/status/:uploadId', entityMasterBulkController.getStatus);
router.post('/upload', upload.single('file'), entityMasterBulkController.upload);

export default router;
