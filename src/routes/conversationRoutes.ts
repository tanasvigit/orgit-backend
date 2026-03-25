import { Router } from 'express';
import {
  getConversations,
  createConversation,
  getConversation,
  getAllUsers,
  pinConversation,
  createGroupConversation,
  createTaskGroupConversation,
  addGroupMembersHandler,
  removeGroupMemberHandler,
  updateGroupConversation,
} from '../controllers/conversationController';
import { authenticate } from '../middleware/authMiddleware';
import { body, param } from 'express-validator';
import { rateLimit } from '../middleware/rateLimitMiddleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// GET /api/conversations - Get all conversations
router.get('/', getConversations);

// POST /api/conversations/create - Create a direct conversation
router.post(
  '/create',
  [body('otherUserId').isUUID().withMessage('otherUserId must be a valid UUID')],
  createConversation
);

// GET /api/conversations/:conversationId - Get conversation details
router.get('/:conversationId', getConversation);

// GET /api/conversations/users/list - Get all users
router.get(
  '/users/list',
  rateLimit({
    windowMs: 60_000, // 1 minute window
    max: 60, // up to 60 list calls per minute per user/IP
  }),
  getAllUsers
);

// PUT /api/conversations/:conversationId/pin - Pin/unpin conversation
router.put(
  '/:conversationId/pin',
  [body('is_pinned').isBoolean().withMessage('is_pinned must be a boolean')],
  pinConversation
);

// POST /api/conversations/groups/create - Create group conversation
router.post(
  '/groups/create',
  [
    body('name').trim().isLength({ min: 1 }).withMessage('Group name is required'),
    body('memberIds').isArray().notEmpty().withMessage('memberIds must be a non-empty array'),
    body('group_photo').optional().isString(),
  ],
  createGroupConversation
);

// POST /api/conversations/groups/task-group - Create task group conversation
router.post(
  '/groups/task-group',
  [
    body('taskId').isUUID().withMessage('taskId must be a valid UUID'),
    body('name').trim().isLength({ min: 1 }).withMessage('Group name is required'),
    body('memberIds').isArray().withMessage('memberIds must be an array'),
  ],
  createTaskGroupConversation
);

// POST /api/conversations/groups/:conversationId/members - Add members to group
router.post(
  '/groups/:conversationId/members',
  [
    body('memberIds').isArray().notEmpty().withMessage('memberIds must be a non-empty array'),
  ],
  addGroupMembersHandler
);

// DELETE /api/conversations/groups/:conversationId/members/:memberId - Remove member from group
router.delete(
  '/groups/:conversationId/members/:memberId',
  [
    param('memberId').isUUID().withMessage('memberId must be a valid UUID'),
  ],
  removeGroupMemberHandler
);

// PUT /api/conversations/groups/:conversationId - Update group
router.put(
  '/groups/:conversationId',
  [
    body('name').optional().trim().isLength({ min: 1 }),
    body('group_photo').optional().isString(),
  ],
  updateGroupConversation
);

export default router;

