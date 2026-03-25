import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { uploadProfilePhoto, deleteProfilePhotoController } from '../controllers/uploadController';
import { profilePhotoMulter } from '../services/profilePhotoUploadService';

const router = Router();

router.post(
  '/profile-photo',
  authenticate,
  profilePhotoMulter.single('file'),
  uploadProfilePhoto
);

router.delete(
  '/profile-photo',
  authenticate,
  deleteProfilePhotoController
);

export default router;
