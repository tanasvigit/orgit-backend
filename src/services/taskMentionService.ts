import { query } from '../config/database';
import { createMessage } from './messageService';
import { getTaskById } from './taskService';
import { getGroupById } from './groupService';

/**
 * Handle task mention in personal chat - cross-post to task group
 */
export const handleTaskMentionInPersonalChat = async (
  messageId: string,
  senderId: string,
  receiverId: string,
  taskMentions: string[],
  messageContent: string,
  senderOrganizationId: string
): Promise<void> => {
  if (!taskMentions || taskMentions.length === 0) {
    return;
  }

  for (const taskId of taskMentions) {
    // Get task details
    const task = await getTaskById(taskId, senderId);
    if (!task) {
      continue; // Skip if task not found or user doesn't have access
    }

    // Get or create task group
    let groupResult = await query(
      `SELECT id FROM groups WHERE task_id = $1 LIMIT 1`,
      [taskId]
    );

    let groupId: string;
    if (groupResult.rows.length === 0) {
      // Create task group if it doesn't exist
      const { createTaskGroup } = await import('./groupService');
      const taskAssignmentsResult = await query(
        `SELECT assigned_to_user_id FROM task_assignments WHERE task_id = $1`,
        [taskId]
      );
      const assignedUserIds = taskAssignmentsResult.rows.map((row) => row.assigned_to_user_id);
      
      const group = await createTaskGroup(taskId, task.creatorId, assignedUserIds, task.organizationId);
      groupId = group.id;
    } else {
      groupId = groupResult.rows[0].id;
    }

    // Cross-post message to task group
    await createMessage(
      senderId,
      null,
      groupId,
      'text',
      `[From personal chat] ${messageContent}`,
      null,
      null,
      null,
      null,
      'shared_to_group',
      senderOrganizationId,
      null,
      null,
      [],
      [taskId]
    );
  }
};

/**
 * Get tasks that can be mentioned by a user
 */
export const getMentionableTasks = async (userId: string): Promise<any[]> => {
  // Get tasks where user is creator or assignee
  const result = await query(
    `SELECT DISTINCT t.*
     FROM tasks t
     LEFT JOIN task_assignments ta ON t.id = ta.task_id
     WHERE (t.creator_id = $1 OR ta.assigned_to_user_id = $1)
     AND t.status != 'completed'
     ORDER BY t.created_at DESC
     LIMIT 50`,
    [userId]
  );

  return result.rows;
};

