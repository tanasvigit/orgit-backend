import { Router } from 'express';
import {
  sendMessage,
  getChatMessages,
  markAsRead,
  editMessageHandler,
  deleteMessageHandler,
  togglePin,
  starMessageHandler,
  unstarMessageHandler,
  searchMessagesHandler,
  addReaction,
  removeReaction,
  getStarredMessagesHandler,
  getMessagesByConversationId,
  markMessagesAsReadByConversationId,
  searchMessagesInConversation,
  forwardMessageHandler,
  uploadImage,
  uploadVideo,
  uploadAudio,
  uploadDocument,
  uploadVoiceNote,
} from '../controllers/messageController';
import { authenticate } from '../middleware/authMiddleware';
import { body, query as queryValidator, param } from 'express-validator';
import { imageUpload, videoUpload, audioUpload, documentUpload, voiceNoteUpload } from '../services/mediaUploadService';

const router = Router();

// All routes require authentication
router.use(authenticate);

router.post(
  '/send',
  [
    body('messageType').isIn(['text', 'image', 'video', 'audio', 'document', 'location', 'contact', 'voice_note']),
    body('visibilityMode').optional().isIn(['org_only', 'shared_to_group']),
  ],
  sendMessage
);

router.get(
  '/',
  [
    queryValidator('receiverId').optional().isUUID(),
    queryValidator('groupId').optional().isUUID(),
    queryValidator('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  getChatMessages
);

router.post('/mark-read', markAsRead);

// Get all starred messages (must be before /:conversationId route)
router.get('/starred/all', getStarredMessagesHandler);

// Search messages (global or chat-level) - matching message-backend route structure
// Route: /search/:conversationId? where conversationId is optional
router.get(
  '/search/:conversationId?',
  [
    param('conversationId').optional().isUUID().withMessage('conversationId must be a valid UUID'),
    queryValidator('query').trim().isLength({ min: 1 }), // message-backend uses 'query' not 'q'
    queryValidator('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  searchMessagesInConversation
);

// Get messages by conversationId (must be before /:messageId routes to avoid conflicts)
// CRITICAL FIX: Accept both UUID and "direct_<userId>" format conversation IDs (matching message-backend)
router.get(
  '/:conversationId',
  [
    // Accept UUID or "direct_<userId>" format
    param('conversationId').custom((value) => {
      if (!value) {
        throw new Error('conversationId is required');
      }
      // Allow UUID format or "direct_<userId>" format
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
      const isDirectFormat = value.startsWith('direct_');
      if (!isUUID && !isDirectFormat) {
        throw new Error('conversationId must be a valid UUID or "direct_<userId>" format');
      }
      return true;
    }),
    queryValidator('limit').optional().isInt({ min: 1, max: 100 }),
    queryValidator('offset').optional().isInt({ min: 0 }),
  ],
  getMessagesByConversationId
);

// Mark messages as read by conversationId
// CRITICAL FIX: Accept both UUID and "direct_<userId>" format conversation IDs (matching message-backend)
router.put(
  '/:conversationId/read',
  [
    // Accept UUID or "direct_<userId>" format
    param('conversationId').custom((value) => {
      if (!value) {
        throw new Error('conversationId is required');
      }
      // Allow UUID format or "direct_<userId>" format
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
      const isDirectFormat = value.startsWith('direct_');
      if (!isUUID && !isDirectFormat) {
        throw new Error('conversationId must be a valid UUID or "direct_<userId>" format');
      }
      return true;
    }),
  ],
  markMessagesAsReadByConversationId
);

// Edit message - matching message-backend route: PUT /:messageId
router.put('/:messageId', [body('content').trim().isLength({ min: 1 })], editMessageHandler);

router.delete('/:messageId', deleteMessageHandler);

router.post('/:messageId/pin', [body('groupId').isUUID(), body('isPinned').isBoolean()], togglePin);

// Star/unstar messages (using starred_messages table)
router.post('/:messageId/star', starMessageHandler);
router.delete('/:messageId/star', unstarMessageHandler);

// Add reaction to message
router.post(
  '/:messageId/reactions',
  [
    body('reaction').trim().isLength({ min: 1 }).withMessage('Reaction is required'),
  ],
  addReaction
);

// Remove reaction from message
router.delete('/:messageId/reactions/:reaction', removeReaction);

// Forward message
router.post(
  '/:messageId/forward',
  [
    body('receiverId').optional().isUUID(),
    body('groupId').optional().isUUID(),
  ],
  forwardMessageHandler
);

// File upload routes (must be before /:messageId routes)
router.post('/upload/image', imageUpload.single('file'), uploadImage);
router.post('/upload/video', videoUpload.single('file'), uploadVideo);
router.post('/upload/audio', audioUpload.single('file'), uploadAudio);
router.post('/upload/document', documentUpload.single('file'), uploadDocument);
router.post('/upload/voice-note', voiceNoteUpload.single('file'), uploadVoiceNote);


export default router;

