import { Request, Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import { query, getClient } from '../config/database';
import { resolveToUrl } from '../services/s3StorageService';

/**
 * Get all conversations (with pinned first) - matching message-backend
 */
export const getConversations = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const rawScope = String(req.query.scope || 'all').toLowerCase();
    const scope: 'all' | 'chat' | 'task' =
      rawScope === 'chat' || rawScope === 'task' ? (rawScope as 'chat' | 'task') : 'all';

    console.log(`[getConversations] Loading conversations for user: ${userId} (scope: ${scope})`);

    // First, check if user has any conversation memberships
    const membershipCheck = await query(
      'SELECT COUNT(*) as count FROM conversation_members WHERE user_id = $1',
      [userId]
    );
    console.log(`[getConversations] User has ${membershipCheck.rows[0]?.count || 0} conversation memberships`);

    // CRITICAL FIX: Get conversations from conversation_members
    // Simplified query that handles all cases - with or without messages
    let result;
    try {
      // Use GROUP BY instead of DISTINCT to avoid JSON type issues
      // Add sort column to SELECT list for ORDER BY compatibility
      result = await query(
        `SELECT 
          CAST(cm.conversation_id AS TEXT) as id,
          c.name,
          COALESCE(c.is_group, FALSE) as is_group,
          COALESCE(c.is_task_group, FALSE) as is_task_group,
          c.group_photo,
          COALESCE(c.created_at, NOW()) as created_at,
          COALESCE(cm.is_pinned, FALSE) as is_pinned,
          COALESCE(cm.role, 'member') as role,
          (
            SELECT json_agg(
              json_build_object(
                'id', u.id,
                'name', u.name,
                'phone', u.mobile,
                'profile_photo', u.profile_photo_url
              )
            )
            FROM conversation_members cm2
            JOIN users u ON cm2.user_id = u.id
            WHERE CAST(cm2.conversation_id AS TEXT) = CAST(cm.conversation_id AS TEXT) AND cm2.user_id != $1
          ) as other_members,
          (
            SELECT COUNT(*)::integer
            FROM conversation_members cm3
            WHERE CAST(cm3.conversation_id AS TEXT) = CAST(cm.conversation_id AS TEXT)
          ) as member_count,
          (
            SELECT json_build_object(
              'id', m.id,
              'content', COALESCE(m.content, ''),
              'message_type', m.message_type,
              'sender_id', m.sender_id,
              'sender_name', u.name,
              'created_at', m.created_at
            )
            FROM messages m
            LEFT JOIN users u ON m.sender_id = u.id
            WHERE CAST(m.conversation_id AS TEXT) = CAST(cm.conversation_id AS TEXT)
              AND m.is_deleted = FALSE
              AND m.deleted_at IS NULL
            ORDER BY m.created_at DESC
            LIMIT 1
          ) as last_message,
          (
            SELECT m.created_at
            FROM messages m
            WHERE CAST(m.conversation_id AS TEXT) = CAST(cm.conversation_id AS TEXT)
              AND m.is_deleted = FALSE
              AND m.deleted_at IS NULL
            ORDER BY m.created_at DESC
            LIMIT 1
          ) as last_message_time,
          COALESCE((
            -- Unread count: use message_status for both group and direct (messages table has no status column)
            (
              SELECT COUNT(*)::integer
              FROM messages m
              LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = $1
              WHERE CAST(m.conversation_id AS TEXT) = CAST(cm.conversation_id AS TEXT)
              AND m.sender_id != $1
              AND (ms.status IS NULL OR ms.status != 'read')
              AND m.is_deleted = FALSE
              AND m.deleted_at IS NULL
            )
          ), 0) as unread_count,
          COALESCE(
            (SELECT created_at FROM messages WHERE CAST(conversation_id AS TEXT) = CAST(cm.conversation_id AS TEXT) AND is_deleted = FALSE ORDER BY created_at DESC LIMIT 1),
            c.created_at,
            NOW()
          ) as sort_time
        FROM conversation_members cm
        LEFT JOIN conversations c ON CAST(c.id AS TEXT) = CAST(cm.conversation_id AS TEXT)
        WHERE cm.user_id = $1
        AND (
          -- Non-task conversations (direct or non-task groups) are always included
          COALESCE(c.is_task_group, FALSE) = FALSE
          -- Task-group conversations are only included when they are still linked to a task
          OR (
            COALESCE(c.is_task_group, FALSE) = TRUE
            AND c.task_id IS NOT NULL
            AND (
              EXISTS (SELECT 1 FROM tasks t WHERE t.id = c.task_id AND (t.created_by = $1 OR t.creator_id = $1))
              OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = c.task_id AND ta.user_id = $1 AND ta.accepted_at IS NOT NULL)
            )
          )
        )
        AND (
          $2 = 'all'
          OR ($2 = 'chat' AND COALESCE(c.is_task_group, FALSE) = FALSE)
          OR ($2 = 'task' AND COALESCE(c.is_task_group, FALSE) = TRUE)
        )
        GROUP BY cm.conversation_id, c.name, c.is_group, c.is_task_group, c.group_photo, c.created_at, cm.is_pinned, cm.role
        ORDER BY 
          COALESCE(cm.is_pinned, FALSE) DESC, 
          sort_time DESC NULLS LAST`,
        [userId, scope]
      );
    } catch (queryError: any) {
      console.error('[getConversations] Main query failed:', queryError.message);
      console.error('[getConversations] Error code:', queryError.code);
      console.error('[getConversations] Error position:', queryError.position);
      console.error('[getConversations] Full error:', JSON.stringify(queryError, null, 2));
      // Fallback to simplest possible query
      try {
        result = await query(
          `SELECT 
          CAST(cm.conversation_id AS TEXT) as id,
          c.name,
          COALESCE(c.is_group, FALSE) as is_group,
          COALESCE(c.is_task_group, FALSE) as is_task_group,
          c.group_photo,
          COALESCE(c.created_at, NOW()) as created_at,
          COALESCE(cm.is_pinned, FALSE) as is_pinned,
          COALESCE(cm.role, 'member') as role,
          NULL as other_members,
          NULL as last_message,
          NULL as last_message_time,
          0 as unread_count,
          COALESCE(c.created_at, NOW()) as sort_time
        FROM conversation_members cm
        LEFT JOIN conversations c ON CAST(c.id AS TEXT) = CAST(cm.conversation_id AS TEXT)
        WHERE cm.user_id = $1
        AND (
          -- Non-task conversations (direct or non-task groups) are always included
          COALESCE(c.is_task_group, FALSE) = FALSE
          -- Task-group conversations are only included when they are still linked to a task
          OR (
            COALESCE(c.is_task_group, FALSE) = TRUE
            AND c.task_id IS NOT NULL
            AND (
              EXISTS (SELECT 1 FROM tasks t WHERE t.id = c.task_id AND (t.created_by = $1 OR t.creator_id = $1))
              OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = c.task_id AND ta.user_id = $1 AND ta.accepted_at IS NOT NULL)
            )
          )
        )
        AND (
          $2 = 'all'
          OR ($2 = 'chat' AND COALESCE(c.is_task_group, FALSE) = FALSE)
          OR ($2 = 'task' AND COALESCE(c.is_task_group, FALSE) = TRUE)
        )
        GROUP BY cm.conversation_id, c.name, c.is_group, c.is_task_group, c.group_photo, c.created_at, cm.is_pinned, cm.role
        ORDER BY COALESCE(cm.is_pinned, FALSE) DESC, sort_time DESC`,
          [userId, scope]
        );
        console.log(`[getConversations] Fallback query found ${result.rows.length} conversations`);
      } catch (fallbackError: any) {
        console.error('[getConversations] Fallback query also failed:', fallbackError.message);
        console.error('[getConversations] Fallback error details:', JSON.stringify(fallbackError, null, 2));
        // Return empty array if both queries fail
        result = { rows: [] };
      }
    }

    console.log(`[getConversations] Found ${result.rows.length} conversations for user ${userId}`);

    // Transform the data to match mobile app expectations
    const transformedConversations = result.rows.map((conv: any) => {
      try {
        // Extract other user info for direct conversations
        const otherMembers = Array.isArray(conv.other_members) ? conv.other_members : [];
        const isGroup = conv.is_group || conv.is_task_group;

        // Normalize other_members to include a resolved profile_photo_url for UI compatibility
        const normalizedOtherMembers = otherMembers.map((member: any) => {
          const rawPhoto = member.profile_photo || member.profile_photo_url || null;
          const resolvedPhoto = rawPhoto ? resolveToUrl(rawPhoto) || rawPhoto : null;
          return {
            ...member,
            profile_photo_url: resolvedPhoto,
            profile_photo: resolvedPhoto,
          };
        });

        // Resolve group photo as well (S3 key or local path -> URL)
        const rawGroupPhoto = conv.group_photo || null;
        const resolvedGroupPhoto = rawGroupPhoto ? resolveToUrl(rawGroupPhoto) || rawGroupPhoto : null;

        return {
          ...conv,
          // Add fields expected by mobile app
          conversationId: conv.id,
          type: isGroup ? 'group' : 'direct',
          otherUserId: !isGroup && normalizedOtherMembers.length > 0 ? normalizedOtherMembers[0].id : null,
          groupId: isGroup ? conv.id : null,
          photoUrl: isGroup
            ? resolvedGroupPhoto
            : (normalizedOtherMembers[0]?.profile_photo_url || normalizedOtherMembers[0]?.profile_photo || null),
          other_members: normalizedOtherMembers, // Ensure other_members has proper structure
          lastMessage: conv.last_message ? {
            id: conv.last_message.id || null,
            content: conv.last_message.content || '',
            messageType: conv.last_message.message_type || 'text',
            senderId: conv.last_message.sender_id || null,
            senderName: conv.last_message.sender_name || null,
            createdAt: conv.last_message.created_at || conv.last_message_time,
          } : null,
          unreadCount: conv.unread_count || 0,
          isPinned: conv.is_pinned || false,
          updatedAt: conv.last_message_time || conv.created_at,
        };
      } catch (transformError: any) {
        console.error('[getConversations] Error transforming conversation:', transformError, conv);
        // Return minimal conversation object if transformation fails
        return {
          id: conv.id,
          conversationId: conv.id,
          type: (conv.is_group || conv.is_task_group) ? 'group' : 'direct',
          name: conv.name || null,
          is_group: conv.is_group || false,
          is_task_group: conv.is_task_group || false,
          other_members: [],
          last_message: null,
          last_message_time: null,
          unread_count: 0,
          is_pinned: false,
        };
      }
    });

    console.log(`[getConversations] Returning ${transformedConversations.length} transformed conversations`);
    res.json({ conversations: transformedConversations });
  } catch (error: any) {
    console.error('Get conversations error:', error);
    console.error('Error details:', error.message, error.stack);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

/**
 * Create or get 1-to-1 conversation (used by mobile NewChatScreen) - matching message-backend EXACTLY
 */
export const createConversation = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { otherUserId } = req.body;
    
    // Get Socket.IO instance from app (matching message-backend pattern)
    const io = (req as any).app.get('io');

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!otherUserId) {
      return res.status(400).json({ error: 'otherUserId is required' });
    }

    if (userId === otherUserId) {
      return res.status(400).json({ error: 'Cannot create conversation with yourself' });
    }

    // Ensure the other user exists and is active before creating a conversation
    const otherUserResult = await query(
      `SELECT id, status FROM users WHERE id = $1`,
      [otherUserId]
    );

    if (otherUserResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (otherUserResult.rows[0].status !== 'active') {
      return res.status(400).json({ error: 'Cannot start a conversation with an inactive user' });
    }

    // Check if conversation already exists (non-group, non-task)
    const existing = await query(
      `SELECT CAST(c.id AS TEXT) as id
       FROM conversations c
       INNER JOIN conversation_members cm1 ON CAST(c.id AS TEXT) = CAST(cm1.conversation_id AS TEXT)
       INNER JOIN conversation_members cm2 ON CAST(c.id AS TEXT) = CAST(cm2.conversation_id AS TEXT)
       WHERE cm1.user_id = $1 AND cm2.user_id = $2 
         AND COALESCE(c.is_group, FALSE) = FALSE
         AND COALESCE(c.is_task_group, FALSE) = FALSE`,
      [userId, otherUserId]
    );

    let conversationId: string;
    let isNewConversation = false;

    if (existing.rows.length > 0) {
      conversationId = existing.rows[0].id;
    } else {
      // Create new conversation
      const client = await getClient();
      try {
        await client.query('BEGIN');

        const convResult = await client.query(
          `INSERT INTO conversations (id, type, is_group, is_task_group, created_by, created_at, updated_at)
           VALUES (gen_random_uuid(), 'direct', FALSE, FALSE, $1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           RETURNING id`,
          [userId]
        );
        conversationId = String(convResult.rows[0].id);

        await client.query(
          'INSERT INTO conversation_members (conversation_id, user_id, role, added_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
          [conversationId, userId, 'member']
        );

        await client.query(
          'INSERT INTO conversation_members (conversation_id, user_id, role, added_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
          [conversationId, otherUserId, 'member']
        );

        await client.query('COMMIT');
        isNewConversation = true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }

    // Automatically join both users to the conversation room if they're online (matching message-backend)
    if (io && conversationId) {
      // Join creator to room
      const creatorSockets = await io.in(`user_${userId}`).fetchSockets();
      for (const socket of creatorSockets) {
        socket.join(conversationId);
        console.log(`User ${userId} auto-joined conversation room ${conversationId}`);
      }

      // Join other user to room
      const otherUserSockets = await io.in(`user_${otherUserId}`).fetchSockets();
      for (const socket of otherUserSockets) {
        socket.join(conversationId);
        console.log(`User ${otherUserId} auto-joined conversation room ${conversationId}`);
      }

      // Notify both users about the new conversation (if it's new)
      if (isNewConversation) {
        io.to(`user_${userId}`).emit('conversation_created', { conversationId });
        io.to(`user_${otherUserId}`).emit('conversation_created', { conversationId });
      }
    }

    res.status(isNewConversation ? 201 : 200).json({ conversationId });
  } catch (error: any) {
    console.error('Create conversation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Create manual group - matching message-backend
 */
export const createGroupConversation = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { name, memberIds, group_photo } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!name || !Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ error: 'Group name and at least one member required' });
    }

    // Add creator to members if not included
    const allMemberIds = [...new Set([userId, ...memberIds])];

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Create group conversation
      const convResult = await client.query(
        `INSERT INTO conversations (id, type, name, is_group, group_photo, created_by)
         VALUES (gen_random_uuid(), 'group', $1, TRUE, $2, $3)
         RETURNING id`,
        [name, group_photo || null, userId]
      );
      const conversationId = convResult.rows[0].id;

      // Add members (creator as admin, others as members)
      for (const memberId of allMemberIds) {
        await client.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           VALUES ($1, $2, $3)`,
          [conversationId, memberId, memberId === userId ? 'admin' : 'member']
        );
      }

      await client.query('COMMIT');

      res.status(201).json({ conversationId });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error('Create group error:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
};

/**
 * Create auto task group - matching message-backend
 */
export const createTaskGroupConversation = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { taskId, name, memberIds } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!taskId || !name || !Array.isArray(memberIds)) {
      return res.status(400).json({ error: 'Task ID, name, and member IDs required' });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');

      // Create task group conversation
      const convResult = await client.query(
        `INSERT INTO conversations (id, type, name, is_group, is_task_group, task_id, created_by)
         VALUES (gen_random_uuid(), 'group', $1, TRUE, TRUE, $2, $3)
         RETURNING id`,
        [name, taskId, userId]
      );
      const conversationId = convResult.rows[0].id;

      // Add creator and assigned members
      const allMembers = [userId, ...memberIds];
      for (const memberId of allMembers) {
        await client.query(
          `INSERT INTO conversation_members (conversation_id, user_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [conversationId, memberId, memberId === userId ? 'admin' : 'member']
        );
      }

      await client.query('COMMIT');

      res.status(201).json({ conversationId });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error('Create task group error:', error);
    res.status(500).json({ error: 'Failed to create task group' });
  }
};

/**
 * Add members to group - matching message-backend
 */
export const addGroupMembersHandler = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { conversationId } = req.params;
    const { memberIds, taskId: bodyTaskId } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ error: 'Member IDs array required' });
    }

    // Verify user is member of group
    const memberCheck = await query(
      'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    // Verify it's a group and get task_id if this is a task group (for task flow: new members get TODO / Accept / Reject)
    const convCheck = await query(
      'SELECT is_group, is_task_group, task_id FROM conversations WHERE id = $1',
      [conversationId]
    );

    if (!convCheck.rows[0]?.is_group) {
      return res.status(400).json({ error: 'Not a group conversation' });
    }

    const isTaskGroup = !!convCheck.rows[0]?.is_task_group;
    // Use conversation's task_id first; fallback to body taskId so new members appear in Task Management even if conversation.task_id is null
    let taskId: string | null = convCheck.rows[0]?.task_id ?? null;
    if (!taskId && isTaskGroup && bodyTaskId) {
      const taskExists = await query('SELECT id FROM tasks WHERE id = $1', [bodyTaskId]);
      if (taskExists.rows.length > 0) {
        taskId = bodyTaskId;
        await query(
          'UPDATE conversations SET task_id = $1 WHERE id = $2 AND task_id IS NULL',
          [bodyTaskId, conversationId]
        );
      }
    }

    // Add members to conversation
    for (const memberId of memberIds) {
      await query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [conversationId, memberId]
      );
    }

    // Task flow: when adding members to an ongoing task group, add them as task assignees (no accepted_at)
    // so they see the task in Task Management and can Accept / Reject
    if (isTaskGroup && taskId) {
      // Derive initial member lifecycle status from start_date: scheduled until start_date (date+time), else todo
      let assigneeStatus: 'scheduled' | 'todo' = 'todo';
      try {
        const tRes = await query(`SELECT start_date FROM tasks WHERE id = $1`, [taskId]);
        const startRaw = tRes.rows[0]?.start_date;
        if (startRaw) {
          const startMs = new Date(startRaw as any).getTime();
          if (Number.isFinite(startMs) && Date.now() < startMs) {
            assigneeStatus = 'scheduled';
          }
        }
      } catch {
        assigneeStatus = 'todo';
      }
      for (const memberId of memberIds) {
        await query(
          `INSERT INTO task_assignees (task_id, user_id, status, role)
           VALUES ($1, $2, $3, 'member')
           ON CONFLICT (task_id, user_id) DO NOTHING`,
          [taskId, memberId, assigneeStatus]
        );
      }
    }

    res.json({ success: true, added: memberIds.length });
  } catch (error: any) {
    console.error('Add members error:', error);
    res.status(500).json({ error: 'Failed to add members' });
  }
};

/**
 * Remove member from group - matching message-backend
 * Allows users to leave the group themselves (self-removal)
 * For removing others: admins can remove any member, regular members cannot remove others
 */
export const removeGroupMemberHandler = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { conversationId, memberId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify user is member
    const memberCheck = await query(
      'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const userRole = memberCheck.rows[0].role;
    const isSelfRemoval = memberId === userId;

    // Allow self-removal (leaving the group) - any member can leave anytime
    if (isSelfRemoval) {
      await query(
        'DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, memberId]
      );
      return res.json({ success: true, message: 'You have left the group' });
    }

    // For removing others: only admins can remove other members
    if (userRole !== 'admin') {
      return res.status(403).json({ error: 'Only group admins can remove other members' });
    }

    // Check if trying to remove an admin (admins cannot be removed by other admins)
    const targetMemberCheck = await query(
      'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, memberId]
    );

    if (targetMemberCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found in this group' });
    }

    if (targetMemberCheck.rows[0].role === 'admin') {
      return res.status(400).json({ error: 'Cannot remove another admin from the group' });
    }

    // Admin removing a regular member
    await query(
      'DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, memberId]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Remove member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
};

/**
 * Update group (name, photo) - admin only - matching message-backend
 */
export const updateGroupConversation = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { conversationId } = req.params;
    const { name, group_photo } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify user is admin
    const memberCheck = await query(
      'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0 || memberCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only group admin can update group' });
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramCount = 1;

    if (name) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (group_photo !== undefined) {
      updates.push(`group_photo = $${paramCount++}`);
      values.push(group_photo);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(conversationId);

    await query(
      `UPDATE conversations SET ${updates.join(', ')} WHERE id = $${paramCount}`,
      values
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Update group error:', error);
    res.status(500).json({ error: 'Failed to update group' });
  }
};

/**
 * Pin/Unpin conversation - matching message-backend
 */
export const pinConversation = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { conversationId } = req.params;
    const { is_pinned } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await query(
      `UPDATE conversation_members
       SET is_pinned = $1
       WHERE conversation_id = $2 AND user_id = $3`,
      [is_pinned === true, conversationId, userId]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Pin conversation error:', error);
    res.status(500).json({ error: 'Failed to pin conversation' });
  }
};

/**
 * Get conversation details - matching message-backend
 */
export const getConversation = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const { conversationId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify user is member
    const memberCheck = await query(
      'SELECT role, is_pinned FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    // Get conversation details
    const convResult = await query(
      'SELECT * FROM conversations WHERE id = $1',
      [conversationId]
    );

    const conv = convResult.rows[0];
    if (conv && conv.is_task_group && conv.task_id) {
      // Ensure we never return a task_id for a deleted task (task no longer exists)
      const taskExists = await query(
        'SELECT 1 FROM tasks WHERE id = $1 LIMIT 1',
        [conv.task_id]
      );
      if (taskExists.rows.length === 0) {
        conv.task_id = null;
      }
    }

    // Get members with roles
    const membersResult = await query(
      `SELECT u.id, u.name, u.mobile as phone, u.profile_photo_url as profile_photo, cm.role, cm.added_at
       FROM conversation_members cm
       JOIN users u ON cm.user_id = u.id
       WHERE cm.conversation_id = $1
       ORDER BY cm.role DESC, cm.added_at ASC`,
      [conversationId]
    );

    // Resolve profile photo URLs for members
    const membersWithResolvedPhotos = membersResult.rows.map((member: any) => {
      const photoValue = member.profile_photo || null;
      const resolvedUrl = photoValue ? resolveToUrl(photoValue) || photoValue : null;
      return {
        ...member,
        profile_photo: resolvedUrl,
        profile_photo_url: resolvedUrl,
      };
    });

    res.json({
      conversation: convResult.rows[0],
      members: membersWithResolvedPhotos,
      userRole: memberCheck.rows[0].role,
      isPinned: memberCheck.rows[0].is_pinned,
    });
  } catch (error: any) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Get all users (for creating new 1-to-1 conversations) - matching message-backend
 */
export const getAllUsers = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const userRole = req.user?.role;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // If user is not super_admin, exclude super_admin users from results
    const roleFilter = userRole === 'super_admin' 
      ? '' 
      : " AND role != 'super_admin'";

    const result = await query(
      `SELECT u.id, u.name, u.mobile as phone, u.profile_photo_url as profile_photo,
              (u.status = 'active') as is_active,
              (SELECT organization_id FROM user_organizations WHERE user_id = u.id LIMIT 1) as organization_id
       FROM users u
       WHERE (u.status = 'active') AND u.id != $1${roleFilter}
       ORDER BY u.name`,
      [userId]
    );

    // Resolve profile photo URLs
    const usersWithResolvedPhotos = result.rows.map((user: any) => {
      const photoValue = user.profile_photo || null;
      const resolvedUrl = photoValue ? resolveToUrl(photoValue) || photoValue : null;
      return {
        ...user,
        profile_photo: resolvedUrl,
        profile_photo_url: resolvedUrl,
      };
    });

    res.json({ users: usersWithResolvedPhotos });
  } catch (error: any) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
