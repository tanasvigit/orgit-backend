import { query } from '../config/database';
import { dispatchNotification } from './notification-bus.service';
import { postTaskUserActionMessage } from './taskActionMessage.service';

export type NotifyNewTaskAssigneesInput = {
  io?: any;
  taskId: string;
  conversationId?: string | null;
  newAssigneeIds: string[];
  addedByUserId?: string | null;
  taskTitle?: string | null;
  actorName?: string | null;
};

/**
 * Notify users newly added as task assignees (in-app badge + push).
 * Also emits task:assignees_added so clients refresh task/chat unread counts.
 */
export async function notifyNewTaskAssignees(
  input: NotifyNewTaskAssigneesInput
): Promise<void> {
  const recipients = [...new Set((input.newAssigneeIds || []).map((id) => String(id).trim()))].filter(
    (id) => id && (!input.addedByUserId || String(id) !== String(input.addedByUserId))
  );

  if (recipients.length === 0) return;

  let actorName = String(input.actorName || '').trim();
  if (!actorName && input.addedByUserId) {
    const actorResult = await query(`SELECT name FROM users WHERE id = $1`, [input.addedByUserId]);
    actorName = actorResult.rows[0]?.name || 'User';
  }
  if (!actorName) actorName = 'User';

  let taskTitle = String(input.taskTitle || '').trim();
  if (!taskTitle) {
    const titleResult = await query(`SELECT title FROM tasks WHERE id = $1`, [input.taskId]);
    taskTitle = titleResult.rows[0]?.title || 'Task';
  }

  let conversationId = input.conversationId ?? null;
  if (!conversationId) {
    const convResult = await query(
      `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
      [input.taskId]
    );
    conversationId = convResult.rows[0]?.id ?? null;
  }

  const io = input.io;

  try {
    await dispatchNotification({
      type: 'TASK_ASSIGNED',
      recipientIds: recipients,
      title: 'Task assigned to you',
      body: `You have been added to: ${taskTitle}`,
      refId: input.taskId,
      refType: 'task',
      io,
    });
  } catch (error: any) {
    console.warn('[notifyNewTaskAssignees] TASK_ASSIGNED failed:', error?.message || error);
  }

  if (conversationId && input.addedByUserId) {
    try {
      await postTaskUserActionMessage({
        io,
        taskId: input.taskId,
        actorUserId: input.addedByUserId,
        action: 'assignees_added',
        actorName,
        count: input.newAssigneeIds.length,
        conversationId,
      });
    } catch (error: any) {
      console.warn('[notifyNewTaskAssignees] task chat message failed:', error?.message || error);
    }
  }

  if (io) {
    for (const recipientId of recipients) {
      io.to(`user_${recipientId}`).emit('task:assignees_added', {
        taskId: input.taskId,
        conversationId,
      });
    }
  }
}
