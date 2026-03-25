import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import { saveProfilePhotoAndUpdateUser, deleteProfilePhoto } from '../services/profilePhotoUploadService';

export const uploadProfilePhoto = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const file = req.file;
    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded. Please select an image.',
      });
    }
    const { url } = await saveProfilePhotoAndUpdateUser(userId, file);
    return res.json({
      success: true,
      data: { url },
    });
  } catch (err: any) {
    console.error('Profile photo upload error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to upload photo. Please try again.',
    });
  }
};

export const deleteProfilePhotoController = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    
    await deleteProfilePhoto(userId);
    
    return res.json({
      success: true,
      message: 'Profile photo deleted successfully',
    });
  } catch (err: any) {
    console.error('Profile photo delete error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Failed to delete photo. Please try again.',
    });
  }
};
