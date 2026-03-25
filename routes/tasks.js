const express = require('express');
const pool = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get all tasks for the authenticated user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { type, status, priority } = req.query;

    let query = `
      SELECT 
        t.*,
        json_agg(
          DISTINCT jsonb_build_object(
            'id', u.id,
            'name', u.name,
            'phone', u.phone,
            'profile_photo', u.profile_photo,
            'accepted_at', ta.accepted_at, 
            'has_accepted', CASE WHEN ta.accepted_at IS NOT NULL THEN true ELSE false END,
            'has_rejected', CASE WHEN ta.rejected_at IS NOT NULL THEN true ELSE false END,
            'completed_at', ta.completed_at,
            'verified_at', ta.verified_at
          )
        ) FILTER (WHERE u.id IS NOT NULL) as assignees,
        (
          SELECT COUNT(*)
          FROM task_assignees ta2
          WHERE ta2.task_id = t.id AND ta2.accepted_at IS NOT NULL
        ) as accepted_count,
        (
          SELECT COUNT(*)
          FROM task_assignees ta2
          WHERE ta2.task_id = t.id AND ta2.rejected_at IS NOT NULL
        ) as rejected_count,
        (
          SELECT COUNT(*)
          FROM task_assignees ta2
          WHERE ta2.task_id = t.id
        ) as total_assignees,
        (
          SELECT jsonb_build_object(
            'accepted_at', ta3.accepted_at,
            'rejected_at', ta3.rejected_at,
            'has_accepted', CASE WHEN ta3.accepted_at IS NOT NULL THEN true ELSE false END,
            'has_rejected', CASE WHEN ta3.rejected_at IS NOT NULL THEN true ELSE false END
          )
          FROM task_assignees ta3
          WHERE ta3.task_id = t.id AND ta3.user_id = $1
        ) as current_user_status,
        c.id as conversation_id,
        c.name as conversation_name
      FROM tasks t
      LEFT JOIN task_assignees ta ON t.id = ta.task_id
      LEFT JOIN users u ON ta.user_id = u.id
      LEFT JOIN conversations c ON c.task_id = t.id AND c.is_task_group = TRUE
      WHERE (
        -- User is an assignee of the task (they're in task_assignees table)
        ta.user_id = $1
        OR 
        -- User is the actual task creator (t.created_by = userId)
        -- This will only match if user is the real creator, not if they created it for someone else
        t.created_by = $1
      )
    `;

    const params = [userId];
    const conditions = [];

    // Always filter by task_type if provided
    if (type) {
      conditions.push(`t.task_type = $${params.length + 1}`);
      params.push(type);
    }

    if (status) {
      conditions.push(`t.status = $${params.length + 1}`);
      params.push(status);
    }

    if (priority) {
      conditions.push(`t.priority = $${params.length + 1}`);
      params.push(priority);
    }

    if (conditions.length > 0) {
      query += ` AND ${conditions.join(' AND ')}`;
    }

    query += `
      GROUP BY t.id, c.id, c.name
      ORDER BY 
        CASE t.priority 
          WHEN 'high' THEN 1 
          WHEN 'medium' THEN 2 
          WHEN 'low' THEN 3 
        END,
        t.due_date ASC,
        t.created_at DESC
    `;

    const result = await pool.query(query, params);
    res.json({ tasks: result.rows });
  } catch (error) {
    console.error('Get tasks error:', error);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Get a single task by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;

    const taskResult = await pool.query(
      `SELECT 
        t.*,
        json_agg(
          DISTINCT jsonb_build_object(
            'id', u.id,
            'name', u.name,
            'phone', u.phone,
            'profile_photo', u.profile_photo,
            'accepted_at', ta.accepted_at,
            'rejected_at', ta.rejected_at,
            'has_accepted', CASE WHEN ta.accepted_at IS NOT NULL THEN true ELSE false END,
            'has_rejected', CASE WHEN ta.rejected_at IS NOT NULL THEN true ELSE false END,
            'completed_at', ta.completed_at,
            'verified_at', ta.verified_at
          )
        ) FILTER (WHERE u.id IS NOT NULL) as assignees,
        (
          SELECT jsonb_build_object(
            'accepted_at', ta2.accepted_at,
            'rejected_at', ta2.rejected_at,
            'has_accepted', CASE WHEN ta2.accepted_at IS NOT NULL THEN true ELSE false END,
            'has_rejected', CASE WHEN ta2.rejected_at IS NOT NULL THEN true ELSE false END
          )
          FROM task_assignees ta2
          WHERE ta2.task_id = t.id AND ta2.user_id = $2
        ) as current_user_status,
        c.id as conversation_id,
        c.name as conversation_name,
        creator.name as creator_name,
        creator.profile_photo as creator_photo
      FROM tasks t
      LEFT JOIN task_assignees ta ON t.id = ta.task_id
      LEFT JOIN users u ON ta.user_id = u.id
      LEFT JOIN conversations c ON c.task_id = t.id AND c.is_task_group = TRUE
      LEFT JOIN users creator ON t.created_by = creator.id
      WHERE t.id = $1 AND (ta.user_id = $2 OR t.created_by = $2)
      GROUP BY t.id, c.id, c.name, creator.name, creator.profile_photo`,
      [id, userId]
    );

    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Get activity log
    const activitiesResult = await pool.query(
      `SELECT 
        ta.*,
        u.name as user_name,
        u.profile_photo as user_photo
      FROM task_activities ta
      LEFT JOIN users u ON ta.user_id = u.id
      WHERE ta.task_id = $1
      ORDER BY ta.created_at DESC`,
      [id]
    );

    const task = taskResult.rows[0];
    task.activities = activitiesResult.rows;
    // Ensure creator_id is set for frontend (task owner; used for Verify button visibility)
    if (!task.creator_id && task.created_by) {
      task.creator_id = task.created_by;
    }

    // Ensure assignees array is properly formatted
    if (task.assignees && Array.isArray(task.assignees)) {
      task.assignees = task.assignees.map(assignee => ({
        ...assignee,
        completed_at: assignee.completed_at || null,
        verified_at: assignee.verified_at || null,
      }));
    }

    res.json({ task });
  } catch (error) {
    console.error('Get task error:', error);
    res.status(500).json({ error: 'Failed to fetch task' });
  }
});

// Create a new task
router.post('/', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.user.userId;
    const {
      title,
      description,
      task_type,
      priority,
      assignee_ids,
      start_date,
      target_date,
      due_date,
      recurrence_type,
      recurrence_interval,
      auto_escalate,
      escalation_rules,
      creator_id, // Allow creator_id to be passed from frontend
    } = req.body;

    if (!title || !due_date) {
      return res.status(400).json({ error: 'Title and due date are required' });
    }

    // Use creator_id if provided, otherwise use authenticated user's ID
    const taskCreatorId = creator_id || userId;
    
    // Debug logging
    console.log('[createTask] Task creation:', {
      userId,
      creator_id: creator_id || 'not provided',
      taskCreatorId,
      isDifferentOwner: creator_id && creator_id !== userId
    });
    
    // Store original creator in escalation_rules if different from task creator
    // This helps us prevent original creator from being added to conversation
    let finalEscalationRules = escalation_rules;
    if (creator_id && creator_id !== userId) {
      // Store original creator info in escalation_rules metadata
      const rulesWithCreator = {
        ...(escalation_rules || {}),
        _metadata: {
          original_creator_id: userId,
          task_creator_id: taskCreatorId
        }
      };
      finalEscalationRules = rulesWithCreator;
    }

    // Insert task
    const taskResult = await client.query(
      `INSERT INTO tasks (
        title, description, task_type, priority, created_by,
        start_date, target_date, due_date,
        recurrence_type, recurrence_interval,
        auto_escalate, escalation_rules
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        title,
        description,
        task_type || 'one_time',
        priority || 'medium',
        taskCreatorId, // Use the determined creator ID
        start_date || null,
        target_date || null,
        due_date,
        recurrence_type || null,
        recurrence_interval || 1,
        auto_escalate || false,
        finalEscalationRules ? JSON.stringify(finalEscalationRules) : null,
      ]
    );

    const task = taskResult.rows[0];

    // Assign task to users - Always include creator as assignee
    const allAssigneeIds = new Set(assignee_ids || []);
    
    // Always add creator as assignee (use taskCreatorId, not userId)
    // This ensures task owner is always an assignee, even if not explicitly selected
    allAssigneeIds.add(taskCreatorId);

    // CRITICAL: If someone created the task for another task owner, ensure the requester
    // (authenticated user) is NOT added as an assignee (and thus cannot join the task group)
    // This is a safety check - mobile should already filter this out, but we enforce it here too
    if (taskCreatorId && userId && taskCreatorId !== userId) {
      const wasInSet = allAssigneeIds.has(userId);
      allAssigneeIds.delete(userId); // Force remove userId regardless
      console.log('[createTask] Task created with different owner - Removed userId from assignees:', {
        userId,
        taskCreatorId,
        wasInSet,
        originalAssigneeIds: assignee_ids,
        finalAssigneeIds: Array.from(allAssigneeIds),
        message: 'User1 will NOT be in task group - only task owner and selected assignees will be'
      });
    } else {
      console.log('[createTask] Task created with same owner:', {
        userId,
        taskCreatorId,
        finalAssigneeIds: Array.from(allAssigneeIds)
      });
    }
    
    if (allAssigneeIds.size > 0) {
      for (const assigneeId of allAssigneeIds) {
        await client.query(
          `INSERT INTO task_assignees (task_id, user_id)
           VALUES ($1, $2)
           ON CONFLICT (task_id, user_id) DO NOTHING`,
          [task.id, assigneeId]
        );
      }
      
      // Keep task as 'pending' when assignees are added; task moves to 'in_progress' only after assignee(s) accept
    }

    // Create task activity log
    const hasAssignees = allAssigneeIds.size > 0;
    const initialStatus = 'pending';
    await client.query(
      `INSERT INTO task_activities (task_id, user_id, activity_type, new_value, message)
       VALUES ($1, $2, 'created', $3, $4)`,
      [task.id, userId, initialStatus, `Task "${title}" created${hasAssignees ? ' with assignees - Pending acceptance' : ''}`]
    );

    // Auto-create task group conversation
    const conversationResult = await client.query(
      `INSERT INTO conversations (name, is_group, is_task_group, task_id, created_by)
       VALUES ($1, TRUE, TRUE, $2, $3)
       RETURNING *`,
      [`Task: ${title}`, task.id, taskCreatorId]
    );

    const conversation = conversationResult.rows[0];

    // Add only creator (admin) to conversation initially
    // Assignees will be added only when they accept the task
    // CRITICAL: Only taskCreatorId is added, NOT userId (the requester)
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       VALUES ($1, $2, 'admin')
       ON CONFLICT (conversation_id, user_id) DO NOTHING`,
      [conversation.id, taskCreatorId]
    );
    
    // CRITICAL SAFETY CHECK: If task creator is different from requester,
    // explicitly remove requester from conversation to prevent them from seeing it
    if (taskCreatorId && userId && taskCreatorId !== userId) {
      await client.query(
        `DELETE FROM conversation_members 
         WHERE conversation_id = $1 AND user_id = $2`,
        [conversation.id, userId]
      );
      console.log('[createTask] SAFETY: Explicitly removed requester from conversation:', {
        conversationId: conversation.id,
        removedUserId: userId,
        taskCreatorId: taskCreatorId
      });
    }
    
    console.log('[createTask] Conversation created:', {
      conversationId: conversation.id,
      taskId: task.id,
      conversationCreatedBy: taskCreatorId,
      requesterUserId: userId,
      taskCreatorIsDifferent: taskCreatorId !== userId,
      message: taskCreatorId !== userId 
        ? `Only ${taskCreatorId} (task owner) added to conversation, NOT ${userId} (requester)`
        : `Task creator and requester are same: ${taskCreatorId}`
    });

    // Create auto-generated message in task group
    // Use taskCreatorId as sender (not userId) so the message appears from the task owner
    const messageResult = await client.query(
      `INSERT INTO messages (conversation_id, sender_id, content, message_type, status)
       VALUES ($1, $2, $3, 'text', 'sent')
       RETURNING id`,
      [conversation.id, taskCreatorId, `Task group auto-created`]
    );
    
    const messageId = messageResult.rows[0].id;
    
    // Create message_status entry for the task creator (not userId)
    // Check if message_status table uses status_at or created_at
    try {
      await client.query(
        `INSERT INTO message_status (message_id, user_id, status, status_at)
         VALUES ($1, $2, 'sent', NOW())`,
        [messageId, taskCreatorId]
      );
    } catch (error) {
      // If error is about column name, try with created_at
      if (error.message && error.message.includes('created_at')) {
        await client.query(
          `INSERT INTO message_status (message_id, user_id, status, created_at)
           VALUES ($1, $2, 'sent', NOW())`,
          [messageId, taskCreatorId]
        );
      } else {
        // If message_status table doesn't exist or has different structure, log warning
        console.warn('[createTask] Could not create message_status entry:', error.message);
      }
    }

    // FINAL SAFETY CHECK: Verify requester is NOT in conversation before committing
    if (taskCreatorId && userId && taskCreatorId !== userId) {
      const membershipCheck = await client.query(
        `SELECT user_id FROM conversation_members 
         WHERE conversation_id = $1 AND user_id = $2`,
        [conversation.id, userId]
      );
      
      if (membershipCheck.rows.length > 0) {
        console.error('[createTask] ERROR: Requester found in conversation! Removing...', {
          conversationId: conversation.id,
          userId,
          taskCreatorId
        });
        await client.query(
          `DELETE FROM conversation_members 
           WHERE conversation_id = $1 AND user_id = $2`,
          [conversation.id, userId]
        );
      }
      
      console.log('[createTask] Final verification - Requester membership status:', {
        conversationId: conversation.id,
        userId,
        wasInConversation: membershipCheck.rows.length > 0,
        message: membershipCheck.rows.length > 0 
          ? 'Requester was removed from conversation' 
          : 'Requester correctly NOT in conversation'
      });
    }

    await client.query('COMMIT');

    // POST-COMMIT VERIFICATION: Check conversation membership one more time
    // This helps us catch any issues even after the transaction commits
    if (taskCreatorId && userId && taskCreatorId !== userId) {
      const postCommitCheck = await pool.query(
        `SELECT user_id, role FROM conversation_members 
         WHERE conversation_id = $1 AND user_id = $2`,
        [conversation.id, userId]
      );
      
      if (postCommitCheck.rows.length > 0) {
        console.error('[createTask] CRITICAL ERROR: Requester still in conversation after commit!', {
          conversationId: conversation.id,
          userId,
          taskCreatorId,
          role: postCommitCheck.rows[0].role
        });
        // Remove them outside the transaction
        await pool.query(
          `DELETE FROM conversation_members 
           WHERE conversation_id = $1 AND user_id = $2`,
          [conversation.id, userId]
        );
        console.log('[createTask] Removed requester from conversation post-commit');
      } else {
        console.log('[createTask] Post-commit verification PASSED: Requester correctly NOT in conversation');
      }
      
      // Also verify who IS in the conversation
      const actualMembers = await pool.query(
        `SELECT user_id, role FROM conversation_members WHERE conversation_id = $1`,
        [conversation.id]
      );
      console.log('[createTask] Actual conversation members:', {
        conversationId: conversation.id,
        members: actualMembers.rows.map(r => ({ userId: r.user_id, role: r.role })),
        expectedMembers: [taskCreatorId],
        requesterInList: actualMembers.rows.some(r => r.user_id === userId)
      });
    }

    // Fetch full task with assignees
    const fullTaskResult = await pool.query(
      `SELECT 
        t.*,
        json_agg(
          DISTINCT jsonb_build_object(
            'id', u.id,
            'name', u.name,
            'phone', u.phone,
            'profile_photo', u.profile_photo
          )
        ) FILTER (WHERE u.id IS NOT NULL) as assignees,
        $1::uuid as conversation_id
      FROM tasks t
      LEFT JOIN task_assignees ta ON t.id = ta.task_id
      LEFT JOIN users u ON ta.user_id = u.id
      WHERE t.id = $2
      GROUP BY t.id`,
      [conversation.id, task.id]
    );

    res.status(201).json({ task: fullTaskResult.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create task error:', error);
    res.status(500).json({ error: 'Failed to create task' });
  } finally {
    client.release();
  }
});

// Accept a task
router.post('/:id/accept', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.user.userId;
    const { id } = req.params;

    // Check if user is assigned to this task
    const assigneeCheck = await client.query(
      `SELECT * FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (assigneeCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You are not assigned to this task' });
    }

    // Check if user has already accepted
    if (assigneeCheck.rows[0].accepted_at) {
      return res.status(400).json({ error: 'You have already accepted this task' });
    }

    // Update assignee acceptance
    await client.query(
      `UPDATE task_assignees 
       SET accepted_at = CURRENT_TIMESTAMP, rejected_at = NULL
       WHERE task_id = $1 AND user_id = $2`,
      [id, userId]
    );

    // Add user to task group conversation when they accept
    // BUT: If user created the task with a different contact as owner, don't add them
    const taskInfo = await client.query(
      `SELECT 
        COALESCE(created_by, creator_id) as creator_id,
        escalation_rules
      FROM tasks WHERE id = $1`,
      [id]
    );

    if (taskInfo.rows.length > 0) {
      const taskCreatorId = taskInfo.rows[0].creator_id;
      const escalationRules = taskInfo.rows[0].escalation_rules;
      
      // Check if this user is the original creator (who created the task request)
      let isOriginalCreator = false;
      if (escalationRules) {
        try {
          const rules = typeof escalationRules === 'string' 
            ? JSON.parse(escalationRules) 
            : escalationRules;
          if (rules._metadata && rules._metadata.original_creator_id === userId) {
            isOriginalCreator = true;
          }
        } catch (e) {
          // If parsing fails, ignore
        }
      }
      
      // Don't add to conversation if:
      // 1. User is the original creator AND task creator is different from user
      // 2. User is already the task creator (they're already added as admin)
      const shouldAddToConversation = !isOriginalCreator || taskCreatorId === userId;
      
      console.log('[acceptTask] Conversation membership check:', {
        userId,
        taskCreatorId,
        isOriginalCreator,
        shouldAddToConversation,
        message: isOriginalCreator && taskCreatorId !== userId 
          ? 'Original creator will NOT be added to conversation' 
          : 'User will be added to conversation'
      });
      
      if (shouldAddToConversation) {
        const conversationResult = await client.query(
          `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
          [id]
        );

        if (conversationResult.rows.length > 0) {
          await client.query(
            `INSERT INTO conversation_members (conversation_id, user_id, role)
             VALUES ($1, $2, 'member')
             ON CONFLICT (conversation_id, user_id) DO NOTHING`,
            [conversationResult.rows[0].id, userId]
          );
        }
      } else {
        console.log('[acceptTask] BLOCKED: Original creator prevented from joining conversation');
      }
    }

    // Get task status and assignee counts
    const taskResult = await client.query(
      `SELECT 
        t.status,
        (SELECT COUNT(*) FROM task_assignees WHERE task_id = $1) as total_assignees,
        (SELECT COUNT(*) FROM task_assignees WHERE task_id = $1 AND accepted_at IS NOT NULL) as accepted_count
      FROM tasks t
      WHERE t.id = $1`,
      [id]
    );

    const taskStatus = taskResult.rows[0].status;
    const totalAssignees = parseInt(taskResult.rows[0].total_assignees);
    const acceptedCount = parseInt(taskResult.rows[0].accepted_count);

    // Update task status only when ALL assignees have accepted
    // If more than 2 assignees, require at least 2 to accept (as per requirement)
    const minRequiredAcceptances = totalAssignees > 2 ? 2 : totalAssignees;
    
    if (taskStatus === 'pending' && acceptedCount >= minRequiredAcceptances) {
      // Check if all assignees have accepted
      if (acceptedCount >= totalAssignees) {
        await client.query(
          `UPDATE tasks SET status = 'in_progress' WHERE id = $1`,
          [id]
        );

        // Log activity
        await client.query(
          `INSERT INTO task_activities (task_id, user_id, activity_type, old_value, new_value, message)
           VALUES ($1, $2, 'status_changed', 'pending', 'in_progress', 'All assignees accepted - Task started')`,
          [id, userId]
        );
      } else {
        // Log partial acceptance
        await client.query(
          `INSERT INTO task_activities (task_id, user_id, activity_type, message)
           VALUES ($1, $2, 'accepted', $3)`,
          [id, userId, `Task accepted (${acceptedCount}/${totalAssignees} accepted)`]
        );
      }
    } else {
      // Log acceptance
      await client.query(
        `INSERT INTO task_activities (task_id, user_id, activity_type, message)
         VALUES ($1, $2, 'accepted', $3)`,
        [id, userId, `Task accepted (${acceptedCount}/${totalAssignees} accepted)`]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Task accepted successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Accept task error:', error);
    res.status(500).json({ error: 'Failed to accept task' });
  } finally {
    client.release();
  }
});

// Reject a task
router.post('/:id/reject', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.user.userId;
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    // Check if user is assigned to this task
    const assigneeCheck = await client.query(
      `SELECT * FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (assigneeCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You are not assigned to this task' });
    }

    // Get conversation first (before removing user)
    const conversationResult = await client.query(
      `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
      [id]
    );

    // Update assignee rejection
    await client.query(
      `UPDATE task_assignees 
       SET rejected_at = CURRENT_TIMESTAMP, accepted_at = NULL
       WHERE task_id = $1 AND user_id = $2`,
      [id, userId]
    );

    // Update task rejection reason
    await client.query(
      `UPDATE tasks SET rejection_reason = $1, rejected_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [reason, id]
    );

    // Log activity
    await client.query(
      `INSERT INTO task_activities (task_id, user_id, activity_type, message)
       VALUES ($1, $2, 'rejected', $3)`,
      [id, userId, `Task rejected: ${reason}`]
    );

    // Post rejection message to task group chat (before removing user)
    if (conversationResult.rows.length > 0) {
      // Check if user is still a member (they might not have accepted yet)
      const memberCheck = await client.query(
        `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
        [conversationResult.rows[0].id, userId]
      );

      if (memberCheck.rows.length > 0) {
        // User is a member, post message
        await client.query(
          `INSERT INTO messages (conversation_id, sender_id, content, message_type)
           VALUES ($1, $2, $3, 'text')`,
          [conversationResult.rows[0].id, userId, `Task rejected. Reason: ${reason}`]
        );

        // Remove user from task group conversation after posting message
        await client.query(
          `DELETE FROM conversation_members 
           WHERE conversation_id = $1 AND user_id = $2`,
          [conversationResult.rows[0].id, userId]
        );
      } else {
        // User was never a member (never accepted), admin will see rejection in task details
        // No need to post message or remove from conversation
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Task rejected successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Reject task error:', error);
    res.status(500).json({ error: 'Failed to reject task' });
  } finally {
    client.release();
  }
});

// Update task status
router.patch('/:id/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const { status } = req.body;

    if (!['pending', 'in_progress', 'completed', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const result = await pool.query(
      `UPDATE tasks 
       SET status = $1, 
           completed_at = CASE WHEN $1 = 'completed' THEN CURRENT_TIMESTAMP ELSE completed_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND (created_by = $3 OR EXISTS (
         SELECT 1 FROM task_assignees WHERE task_id = $2 AND user_id = $3
       ))
       RETURNING *`,
      [status, id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Log activity
    await pool.query(
      `INSERT INTO task_activities (task_id, user_id, activity_type, new_value, message)
       VALUES ($1, $2, 'status_changed', $3, $4)`,
      [id, userId, status, `Task status changed to ${status}`]
    );

    res.json({ task: result.rows[0] });
  } catch (error) {
    console.error('Update task status error:', error);
    res.status(500).json({ error: 'Failed to update task status' });
  }
});

// Update task
router.patch('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { id } = req.params;
    const updates = req.body;

    // Build dynamic update query
    const allowedFields = ['title', 'description', 'priority', 'start_date', 'target_date', 'due_date'];
    const updateFields = [];
    const values = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        updateFields.push(`${field} = $${paramIndex}`);
        values.push(updates[field]);
        paramIndex++;
      }
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(id, userId);
    const result = await pool.query(
      `UPDATE tasks 
       SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = $${paramIndex} AND created_by = $${paramIndex + 1}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found or unauthorized' });
    }

    res.json({ task: result.rows[0] });
  } catch (error) {
    console.error('Update task error:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// Add assignees to an existing task - allows task assignees to add more users
router.post('/:id/assignees', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.user.userId;
    const { id } = req.params;
    const { assignee_ids } = req.body;

    if (!assignee_ids || !Array.isArray(assignee_ids) || assignee_ids.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'assignee_ids array is required' });
    }

    // Check if task exists
    const taskResult = await client.query(
      `SELECT id, created_by FROM tasks WHERE id = $1`,
      [id]
    );

    if (taskResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = taskResult.rows[0];

    // Check if user is assigned to this task OR is the creator
    const assigneeCheck = await client.query(
      `SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (assigneeCheck.rows.length === 0 && task.created_by !== userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You must be assigned to this task to add assignees' });
    }

    // Get existing assignee IDs
    const existingAssigneesResult = await client.query(
      `SELECT user_id FROM task_assignees WHERE task_id = $1`,
      [id]
    );
    const existingAssigneeIds = existingAssigneesResult.rows.map(r => r.user_id);

    // Add new assignees (skip ones that already exist)
    const newAssigneeIds = assignee_ids.filter(aid => !existingAssigneeIds.includes(aid));
    
    if (newAssigneeIds.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'All provided users are already assigned to this task' });
    }

    // Insert new assignees
    for (const assigneeId of newAssigneeIds) {
      await client.query(
        `INSERT INTO task_assignees (task_id, user_id)
         VALUES ($1, $2)
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [id, assigneeId]
      );
    }

    // Get task group conversation if it exists
    const conversationResult = await client.query(
      `SELECT id FROM conversations WHERE task_id = $1 AND is_task_group = TRUE LIMIT 1`,
      [id]
    );

    // Add new assignees to task group conversation if it exists
    if (conversationResult.rows.length > 0) {
      const conversationId = conversationResult.rows[0].id;
      for (const assigneeId of newAssigneeIds) {
        await client.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT (conversation_id, user_id) DO NOTHING`,
          [conversationId, assigneeId]
        );
      }
    }

    // Log activity
    await client.query(
      `INSERT INTO task_activities (task_id, user_id, activity_type, message)
       VALUES ($1, $2, 'assignees_added', $3)`,
      [id, userId, `Added ${newAssigneeIds.length} new assignee(s) to the task`]
    );

    await client.query('COMMIT');

    // Fetch updated task with all assignees
    const updatedTaskResult = await client.query(
      `SELECT 
        t.*,
        json_agg(
          DISTINCT jsonb_build_object(
            'id', u.id,
            'name', u.name,
            'phone', u.mobile,
            'profile_photo', u.profile_photo_url,
            'accepted_at', ta.accepted_at,
            'has_accepted', CASE WHEN ta.accepted_at IS NOT NULL THEN true ELSE false END
          )
        ) FILTER (WHERE u.id IS NOT NULL) as assignees
      FROM tasks t
      LEFT JOIN task_assignees ta ON t.id = ta.task_id
      LEFT JOIN users u ON ta.user_id = u.id
      WHERE t.id = $1
      GROUP BY t.id`,
      [id]
    );

    res.json({ 
      success: true, 
      message: `Added ${newAssigneeIds.length} assignee(s) successfully`,
      task: updatedTaskResult.rows[0],
      added_count: newAssigneeIds.length
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Add task assignees error:', error);
    res.status(500).json({ error: 'Failed to add assignees to task' });
  } finally {
    client.release();
  }
});

// Mark member task as complete (user marks their own completion)
router.post('/:id/members/:userId/complete', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentUserId = req.user.userId;
    const { id: taskId, userId: targetUserId } = req.params;

    // User can only mark their own completion
    if (currentUserId !== targetUserId) {
      return res.status(403).json({ error: 'You can only mark your own task as complete' });
    }

    // Check if user is assigned to this task
    const assigneeCheck = await client.query(
      `SELECT * FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
      [taskId, currentUserId]
    );

    if (assigneeCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You are not assigned to this task' });
    }

    // Check if already completed
    if (assigneeCheck.rows[0].completed_at) {
      return res.status(400).json({ error: 'You have already marked this task as complete' });
    }

    // Check if user is the task creator
    const taskCheck = await client.query(
      `SELECT COALESCE(created_by, creator_id) as creator_id FROM tasks WHERE id = $1`,
      [taskId]
    );

    if (taskCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const isCreator = taskCheck.rows[0].creator_id === currentUserId;
    const userName = req.user.name || 'User';

    // Check if user has accepted the task (required for regular assignees)
    // Creator should be able to complete the whole task immediately.
    if (!isCreator && !assigneeCheck.rows[0].accepted_at) {
      return res.status(400).json({ error: 'You must accept the task before marking it as complete' });
    }

    if (isCreator) {
      // If creator completes their task, mark entire task as completed
      // Mark creator's completion with verification
      await client.query(
        `UPDATE task_assignees 
         SET completed_at = CURRENT_TIMESTAMP, verified_at = CURRENT_TIMESTAMP
         WHERE task_id = $1 AND user_id = $2`,
        [taskId, currentUserId]
      );

      // Mark all other assignees as verified (since creator completed)
      await client.query(
        `UPDATE task_assignees 
         SET verified_at = CURRENT_TIMESTAMP
         WHERE task_id = $1 AND completed_at IS NOT NULL AND verified_at IS NULL`,
        [taskId]
      );

      // Mark the entire task as completed
      await client.query(
        `UPDATE tasks SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [taskId]
      );

      // Log activity
      await client.query(
        `INSERT INTO task_activities (task_id, user_id, activity_type, message)
         VALUES ($1, $2, 'status_changed', $3)`,
        [taskId, currentUserId, `Creator (${userName}) completed the task - Task marked as completed`]
      );

      await client.query('COMMIT');
      res.json({ message: 'Task completed. The entire task has been marked as completed.', taskCompleted: true });
    } else {
      // Regular assignee - mark as complete (pending verification)
      await client.query(
        `UPDATE task_assignees 
         SET completed_at = CURRENT_TIMESTAMP, verified_at = NULL
         WHERE task_id = $1 AND user_id = $2`,
        [taskId, currentUserId]
      );

      // Log activity
      await client.query(
        `INSERT INTO task_activities (task_id, user_id, activity_type, message)
         VALUES ($1, $2, 'completion_pending', $3)`,
        [taskId, currentUserId, `${userName} marked their task as complete - Pending verification`]
      );

      await client.query('COMMIT');
      res.json({ message: 'Task marked as complete. Waiting for verification.' });
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Mark complete error:', error);
    res.status(500).json({ error: 'Failed to mark task as complete' });
  } finally {
    client.release();
  }
});

// Verify member completion (creator verifies member's completion)
router.post('/:id/members/:userId/verify', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentUserId = req.user.userId;
    const { id: taskId, userId: targetUserId } = req.params;

    // Check if current user is the task creator
    const taskCheck = await client.query(
      `SELECT COALESCE(created_by, creator_id) as creator_id FROM tasks WHERE id = $1`,
      [taskId]
    );

    if (taskCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (taskCheck.rows[0].creator_id !== currentUserId) {
      return res.status(403).json({ error: 'Only the task creator can verify completions' });
    }

    // Check if target user is assigned and has marked as complete
    const assigneeCheck = await client.query(
      `SELECT * FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
      [taskId, targetUserId]
    );

    if (assigneeCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User is not assigned to this task' });
    }

    if (!assigneeCheck.rows[0].completed_at) {
      return res.status(400).json({ error: 'User has not marked their task as complete yet' });
    }

    if (assigneeCheck.rows[0].verified_at) {
      return res.status(400).json({ error: 'Completion has already been verified' });
    }

    // Verify the completion
    await client.query(
      `UPDATE task_assignees 
       SET verified_at = CURRENT_TIMESTAMP
       WHERE task_id = $1 AND user_id = $2`,
      [taskId, targetUserId]
    );

    // Get user name for activity log
    const userResult = await client.query(
      `SELECT name FROM users WHERE id = $1`,
      [targetUserId]
    );
    const userName = userResult.rows[0]?.name || 'User';

    // Log activity
    await client.query(
      `INSERT INTO task_activities (task_id, user_id, activity_type, message)
       VALUES ($1, $2, 'completion_verified', $3)`,
      [taskId, currentUserId, `Creator verified ${userName}'s completion`]
    );

    // Check if all assignees who completed have been verified.
    // Creator may be in task_assignees but without completed_at (they verify, not "do").
    // Task is done when: every assignee with completed_at also has verified_at.
    const allAssigneesResult = await client.query(
      `SELECT 
        COUNT(CASE WHEN completed_at IS NOT NULL THEN 1 END) as completed_count,
        COUNT(CASE WHEN completed_at IS NOT NULL AND verified_at IS NOT NULL THEN 1 END) as verified_completed_count
       FROM task_assignees 
       WHERE task_id = $1`,
      [taskId]
    );

    const completedCount = parseInt(allAssigneesResult.rows[0].completed_count) || 0;
    const verifiedCompletedCount = parseInt(allAssigneesResult.rows[0].verified_completed_count) || 0;

    // If all who completed are verified (and at least one completed), mark task as completed
    const allCompletedAndVerified = completedCount > 0 && completedCount === verifiedCompletedCount;

    // Mark task completed so assignees (e.g. Dilli) see Completed. Creator still sees In Progress in Self until they mark complete (dashboard logic).
    if (allCompletedAndVerified) {
      await client.query(
        `UPDATE tasks SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [taskId]
      );
      await client.query(
        `INSERT INTO task_activities (task_id, user_id, activity_type, message)
         VALUES ($1, $2, 'status_changed', $3)`,
        [taskId, currentUserId, 'All members completed and verified - Task completed']
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Completion verified successfully', allCompleted: allCompletedAndVerified });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Verify completion error:', error);
    res.status(500).json({ error: 'Failed to verify completion' });
  } finally {
    client.release();
  }
});

module.exports = router;

