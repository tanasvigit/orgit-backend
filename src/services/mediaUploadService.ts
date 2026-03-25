import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import {
  isConfigured as isS3Configured,
  upload as s3Upload,
  resolveToUrl,
  isS3Key,
  deleteObject as s3DeleteObject,
} from './s3StorageService';

// Maximum file sizes (in bytes)
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_AUDIO_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_VOICE_NOTE_SIZE = 10 * 1024 * 1024; // 10MB

// Upload directory (local fallback)
const uploadDir = path.join(process.cwd(), 'uploads', 'messages');
// Create directory if it doesn't exist (async, non-blocking)
fs.promises.mkdir(uploadDir, { recursive: true }).catch(console.error);

// Allowed MIME types
const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
];

const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
];

const ALLOWED_AUDIO_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/ogg',
  'audio/aac',
  'audio/webm',
];

const ALLOWED_DOCUMENT_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
];

const ALLOWED_VOICE_NOTE_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/ogg',
  'audio/aac',
  'audio/webm',
  'audio/x-m4a',
];

// Disk storage for local (when S3 not configured)
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.promises.mkdir(uploadDir, { recursive: true })
      .then(() => cb(null, uploadDir))
      .catch((error) => cb(error, uploadDir));
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

// Use memory storage when S3 is configured (buffer needed for upload)
const storage = isS3Configured() ? multer.memoryStorage() : diskStorage;

/**
 * File filter for images
 */
const imageFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  
  if (ALLOWED_IMAGE_TYPES.includes(file.mimetype) || allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files (JPEG, PNG, GIF, WEBP) are allowed'));
  }
};

/**
 * File filter for videos
 */
const videoFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExtensions = ['.mp4', '.mpeg', '.mov', '.avi', '.webm'];
  
  if (ALLOWED_VIDEO_TYPES.includes(file.mimetype) || allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only video files (MP4, MPEG, MOV, AVI, WEBM) are allowed'));
  }
};

/**
 * File filter for audio files
 */
const audioFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.webm', '.m4a'];
  
  if (ALLOWED_AUDIO_TYPES.includes(file.mimetype) || allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only audio files (MP3, WAV, OGG, AAC, WEBM, M4A) are allowed'));
  }
};

/**
 * File filter for documents
 */
const documentFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt'];
  
  if (ALLOWED_DOCUMENT_TYPES.includes(file.mimetype) || allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only document files (PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, TXT) are allowed'));
  }
};

/**
 * File filter for voice notes
 */
const voiceNoteFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExtensions = ['.mp3', '.wav', '.ogg', '.aac', '.webm', '.m4a'];
  
  if (ALLOWED_VOICE_NOTE_TYPES.includes(file.mimetype) || allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only voice note files (MP3, WAV, OGG, AAC, WEBM, M4A) are allowed'));
  }
};

/**
 * Multer upload configurations for different message types
 */
export const imageUpload = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_SIZE },
  fileFilter: imageFilter,
});

export const videoUpload = multer({
  storage,
  limits: { fileSize: MAX_VIDEO_SIZE },
  fileFilter: videoFilter,
});

export const audioUpload = multer({
  storage,
  limits: { fileSize: MAX_AUDIO_SIZE },
  fileFilter: audioFilter,
});

export const documentUpload = multer({
  storage,
  limits: { fileSize: MAX_DOCUMENT_SIZE },
  fileFilter: documentFilter,
});

export const voiceNoteUpload = multer({
  storage,
  limits: { fileSize: MAX_VOICE_NOTE_SIZE },
  fileFilter: voiceNoteFilter,
});

/**
 * Upload message media to S3 (when configured). Call after multer when req.file.buffer exists.
 * Returns { fileUrl, filename } where filename is the value to store in DB (S3 key or local path).
 */
export async function uploadMessageMediaToStorage(
  file: Express.Multer.File
): Promise<{ fileUrl: string; filename: string }> {
  if (isS3Configured() && file.buffer) {
    const ext = path.extname(file.originalname).toLowerCase();
    const key = `messages/${uuidv4()}${ext}`;
    const storedKey = await s3Upload(key, file.buffer, file.mimetype);
    const fileUrl = resolveToUrl(storedKey) || storedKey;
    return { fileUrl, filename: storedKey };
  }
  const filename = file.filename;
  return { fileUrl: `/uploads/messages/${filename}`, filename: `/uploads/messages/${filename}` };
}

/**
 * Upload document PDF to document-pdfs/ prefix (for document management)
 */
export async function uploadDocumentPDFToStorage(
  file: Express.Multer.File
): Promise<{ fileUrl: string; filename: string }> {
  if (isS3Configured() && file.buffer) {
    const ext = path.extname(file.originalname).toLowerCase();
    const key = `document-pdfs/${uuidv4()}${ext}`;
    const storedKey = await s3Upload(key, file.buffer, file.mimetype);
    const fileUrl = resolveToUrl(storedKey) || storedKey;
    return { fileUrl, filename: storedKey };
  }
  // Local fallback: use document-pdfs directory
  const documentPdfsDir = path.join(process.cwd(), 'uploads', 'document-pdfs');
  await fs.promises.mkdir(documentPdfsDir, { recursive: true }).catch(console.error);
  const filename = file.filename;
  return { fileUrl: `/uploads/document-pdfs/${filename}`, filename: `/uploads/document-pdfs/${filename}` };
}

/**
 * Get file URL for client. storedValue is either S3 key (no leading slash) or local path (/uploads/messages/...).
 */
export const getFileUrl = (storedValue: string): string => {
  if (isS3Key(storedValue)) {
    const url = resolveToUrl(storedValue);
    return url || storedValue;
  }
  if (storedValue.startsWith('/')) return storedValue;
  return `/uploads/messages/${storedValue}`;
};

/**
 * Get full local file path (for local storage only).
 */
export const getFilePath = (filename: string): string => {
  return path.join(uploadDir, filename);
};

/**
 * Delete file from storage. storedValue is S3 key or local path (/uploads/messages/...).
 */
export const deleteFile = async (storedValue: string): Promise<void> => {
  if (isS3Key(storedValue)) {
    try {
      await s3DeleteObject(storedValue);
    } catch (error: any) {
      console.error('Error deleting file from S3:', error);
      throw error;
    }
    return;
  }
  const relativePath = storedValue.startsWith('/uploads/') ? storedValue.replace(/^\//, '') : `messages/${storedValue}`;
  const filePath = path.join(process.cwd(), relativePath);
  try {
    await fs.promises.unlink(filePath);
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      console.error('Error deleting file:', error);
      throw error;
    }
  }
};

/**
 * Generate thumbnail for video (placeholder - in production, use ffmpeg)
 */
export const generateVideoThumbnail = async (videoPath: string): Promise<string | null> => {
  // TODO: Implement video thumbnail generation using ffmpeg
  // For now, return null - client should provide thumbnail
  return null;
};

/**
 * Get file metadata (local files only; returns null for S3 keys).
 */
export const getFileMetadata = async (filename: string): Promise<{
  size: number;
  mimeType: string;
  extension: string;
} | null> => {
  if (isS3Key(filename)) return null;
  const shortName = filename.replace(/^\/uploads\/messages\//, '');
  const filePath = getFilePath(shortName);
  try {
    const stats = await fs.promises.stat(filePath);
    const ext = path.extname(shortName).toLowerCase();
    
    // Determine MIME type from extension
    let mimeType = 'application/octet-stream';
    if (['.jpg', '.jpeg'].includes(ext)) mimeType = 'image/jpeg';
    else if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.gif') mimeType = 'image/gif';
    else if (ext === '.webp') mimeType = 'image/webp';
    else if (ext === '.mp4') mimeType = 'video/mp4';
    else if (ext === '.mp3') mimeType = 'audio/mpeg';
    else if (ext === '.wav') mimeType = 'audio/wav';
    else if (ext === '.pdf') mimeType = 'application/pdf';
    else if (['.doc', '.docx'].includes(ext)) mimeType = 'application/msword';
    else if (['.xls', '.xlsx'].includes(ext)) mimeType = 'application/vnd.ms-excel';
    
    return {
      size: stats.size,
      mimeType,
      extension: ext,
    };
  } catch (error) {
    console.error('Error getting file metadata:', error);
    return null;
  }
};

