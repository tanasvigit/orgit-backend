/**
 * Profile photo upload: save to disk (uploads/profile-photos) or S3 (profile-photos/).
 * Returns a URL/path to store in users.profile_photo_url.
 */

import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { query } from '../config/database';
import { isConfigured as isS3Configured, upload as s3Upload, resolveToUrl, deleteObject as s3DeleteObject, isS3Key } from './s3StorageService';

const MAX_PROFILE_PHOTO_SIZE = 5 * 1024 * 1024; // 5MB
const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'profile-photos');
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

fs.promises.mkdir(UPLOAD_DIR, { recursive: true }).catch(console.error);

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.promises.mkdir(UPLOAD_DIR, { recursive: true }).then(() => cb(null, UPLOAD_DIR)).catch((err) => cb(err, UPLOAD_DIR));
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const imageFilter: multer.Options['fileFilter'] = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  if (ALLOWED_IMAGE_TYPES.includes(file.mimetype) || allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files (JPEG, PNG, GIF, WEBP) are allowed'));
  }
};

const storage = isS3Configured() ? multer.memoryStorage() : diskStorage;

export const profilePhotoMulter = multer({
  storage,
  limits: { fileSize: MAX_PROFILE_PHOTO_SIZE },
  fileFilter: imageFilter,
});

export async function saveProfilePhotoAndUpdateUser(
  userId: string,
  file: Express.Multer.File
): Promise<{ url: string; storedValue: string }> {
  const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
  const filename = `${uuidv4()}${ext}`;

  let storedValue: string;

  if (isS3Configured() && file.buffer) {
    const key = `profile-photos/${filename}`;
    const fullKey = await s3Upload(key, file.buffer, file.mimetype);
    storedValue = fullKey; // Store the full key (with prefix) returned by s3Upload
  } else if ((file as any).path || (file as any).filename) {
    const name = (file as any).filename || path.basename((file as any).path);
    storedValue = `/uploads/profile-photos/${name}`;
  } else {
    throw new Error('No file buffer or path');
  }

  await query(
    'UPDATE users SET profile_photo_url = $1, updated_at = NOW() WHERE id = $2',
    [storedValue, userId]
  );
  
  // Also update profiles table if it exists
  await query(
    `UPDATE profiles SET profile_photo = $1, updated_at = NOW() WHERE user_id = $2`,
    [storedValue, userId]
  ).catch((error) => {
    // Ignore error if profiles table doesn't exist or user doesn't have a profile record yet
    // Try to insert if update didn't affect any rows
    return query(
      `INSERT INTO profiles (user_id, profile_photo, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (user_id) DO UPDATE SET profile_photo = $2, updated_at = NOW()`,
      [userId, storedValue]
    ).catch((insertError) => {
      console.warn('Could not update profiles.profile_photo (may not exist):', insertError.message);
    });
  });

  const url = storedValue.startsWith('/') ? storedValue : resolveToUrl(storedValue) || storedValue;
  return { url, storedValue };
}

/**
 * Delete profile photo from storage (S3 or disk) and update user record.
 */
export async function deleteProfilePhoto(userId: string): Promise<void> {
  // Get current profile photo URL
  const result = await query(
    'SELECT profile_photo_url FROM users WHERE id = $1',
    [userId]
  );
  
  if (result.rows.length === 0) {
    throw new Error('User not found');
  }
  
  const currentPhotoUrl = result.rows[0].profile_photo_url;
  
  if (!currentPhotoUrl) {
    // No photo to delete
    return;
  }
  
  // Delete from storage
  try {
    if (isS3Key(currentPhotoUrl)) {
      // Delete from S3 - stored value should be the full key (with prefix) from s3Upload
      await s3DeleteObject(currentPhotoUrl);
    } else if (currentPhotoUrl.startsWith('/uploads/')) {
      // Delete from local disk
      const filePath = path.join(process.cwd(), currentPhotoUrl.replace(/^\//, ''));
      try {
        await fs.promises.unlink(filePath);
      } catch (error: any) {
        if (error.code !== 'ENOENT') {
          console.error('Error deleting local profile photo:', error);
          // Continue to update DB even if file deletion fails
        }
      }
    }
  } catch (error: any) {
    console.error('Error deleting profile photo from storage:', error);
    // Continue to update DB even if storage deletion fails
  }
  
  // Update both tables in sequence to ensure consistency
  // First update users table
  await query(
    'UPDATE users SET profile_photo_url = NULL, updated_at = NOW() WHERE id = $1',
    [userId]
  );
  
  // Then update profiles table - ensure this completes successfully
  try {
    await query(
      `UPDATE profiles SET profile_photo = NULL, updated_at = NOW() WHERE user_id = $1`,
      [userId]
    );
  } catch (error: any) {
    // Log error but don't fail - profiles table might not exist or user might not have a profile record
    console.warn('Could not update profiles.profile_photo (may not exist):', error.message);
    // Try to insert a profile record with NULL photo if update didn't affect any rows
    try {
      await query(
        `INSERT INTO profiles (user_id, profile_photo, updated_at) VALUES ($1, NULL, NOW()) ON CONFLICT (user_id) DO UPDATE SET profile_photo = NULL, updated_at = NOW()`,
        [userId]
      );
    } catch (insertError: any) {
      console.warn('Could not insert/update profiles record:', insertError.message);
    }
  }
}
