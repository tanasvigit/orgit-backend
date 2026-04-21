import { Router } from 'express';
import {
  getTasks,
  getTask,
  createTask,
  acceptTask,
  rejectTask,
  updateTaskStatus,
  updateTask,
  deleteTask,
  addTaskAssignees,
  getTaskAssignees,
  markMemberComplete,
  verifyMemberCompletion,
  reassignMember,
  completeTaskForVerification,
  verifyTaskCompletion,
  rejectTaskCompletion,
  requestTaskDelete,
  approveTaskDeleteRequest,
  denyTaskDeleteRequest,
  createExitRequest,
  approveExitRequest,
  rejectExitRequest,
} from '../controllers/taskController';
import {
  linkComplianceToTask,
  unlinkComplianceFromTask,
  getTaskCompliances,
} from '../controllers/taskComplianceController';
import { authenticate } from '../middleware/authMiddleware';
import { body, query as queryValidator } from 'express-validator';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Get all tasks - matching message-backend
router.get(
  '/',
  [
    queryValidator('type').optional().isIn(['one_time', 'recurring', 'recurring_instance', 'recurring_template']),
    queryValidator('status').optional().isIn(['pending', 'todo', 'active', 'in_progress', 'pending_verification', 'completed', 'rejected', 'deleted']),
    queryValidator('priority').optional().isIn(['high', 'medium', 'low']),
  ],
  getTasks
);

// Create a new task - matching message-backend
router.post(
  '/',
  [
    body('title').trim().isLength({ min: 1 }),
    body('due_date').optional(),
    body('client_entity_id').optional().isUUID(),
    body('end_date').optional(),
    body('task_type').optional().isIn(['one_time', 'recurring', 'recurring_instance', 'recurring_template']),
    body('priority').optional().isIn(['high', 'medium', 'low']),
    body('assignee_ids').optional().isArray(),
    body('recurrence_day_of_month').optional().isInt({ min: 1, max: 31 }),
    body('specific_weekday').optional().isInt({ min: 0, max: 6 }),
  ],
  createTask
);

// Accept a task - matching message-backend
router.post('/:id/accept', acceptTask);

// Reject a task - matching message-backend
router.post(
  '/:id/reject',
  [body('reason').trim().isLength({ min: 1 })],
  rejectTask
);

// Update task status - matching message-backend
router.patch(
  '/:id/status',
  [
    body('status').isIn(['pending', 'todo', 'active', 'in_progress', 'pending_verification', 'completed', 'rejected', 'deleted']),
  ],
  updateTaskStatus
);

// Update task - matching message-backend
router.patch('/:id', updateTask);

// Delete task
router.delete('/:id', deleteTask);
router.post('/:id/request-delete', [body('reason').trim().isLength({ min: 1 })], requestTaskDelete);
router.post('/:id/approve-delete-request', approveTaskDeleteRequest);
router.post('/:id/deny-delete-request', denyTaskDeleteRequest);

// Get task assignees - get all members/assignees for a task (must come before /:id)
router.get('/:id/assignees', getTaskAssignees);

// Add assignees to task - allows task assignees to add more users
router.post(
  '/:id/assignees',
  [body('assignee_ids').isArray().notEmpty()],
  addTaskAssignees
);

// Mark member task as complete (user marks their own completion)
router.post('/:id/members/:userId/complete', markMemberComplete);

// Verify member completion (creator verifies member's completion)
router.post('/:id/members/:userId/verify', verifyMemberCompletion);

// Reassign member work (send back from completed to in-progress)
router.post('/:id/members/:userId/reassign', reassignMember);
router.post('/:id/complete', completeTaskForVerification);
router.post('/:id/verify', verifyTaskCompletion);
router.post(
  '/:id/reject-completion',
  [body('reason').trim().isLength({ min: 10 })],
  rejectTaskCompletion
);
router.post('/:id/exit-request', [body('comment').trim().isLength({ min: 1 })], createExitRequest);
router.post('/:id/exit-request/:requestId/approve', approveExitRequest);
router.post('/:id/exit-request/:requestId/reject', rejectExitRequest);

// Compliance linking routes
router.post('/:taskId/compliance', linkComplianceToTask);
router.delete('/:taskId/compliance/:complianceId', unlinkComplianceFromTask);
router.get('/:taskId/compliance', getTaskCompliances);

// Get a single task by ID - matching message-backend (must come last after all /:id/* routes)
router.get('/:id', getTask);

export default router;

