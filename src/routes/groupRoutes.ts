import { Router } from 'express';
import {
  createGroupHandler,
  getUserGroupsHandler,
  getGroupHandler,
  getGroupMembersHandler,
  addMembersHandler,
  removeMemberHandler,
  updateGroupHandler,
} from '../controllers/groupController';
import { authenticate } from '../middleware/authMiddleware';
import { body } from 'express-validator';

const router = Router();

// All routes require authentication
router.use(authenticate);

router.post(
  '/',
  [
    body('name').optional().trim().isLength({ min: 1, max: 255 }),
    body('memberIds').optional().isArray(),
  ],
  createGroupHandler
);

router.get('/', getUserGroupsHandler);

router.get('/:groupId', getGroupHandler);

router.get('/:groupId/members', getGroupMembersHandler);

router.post(
  '/:groupId/members',
  [body('memberIds').isArray().notEmpty()],
  addMembersHandler
);

router.delete('/:groupId/members/:memberId', removeMemberHandler);

router.put(
  '/:groupId',
  [
    body('name').optional().trim().isLength({ min: 1, max: 255 }),
  ],
  updateGroupHandler
);

export default router;

