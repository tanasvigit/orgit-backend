const express = require('express');
const pool = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get all conversations (with pinned first)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(
      `SELECT 
        c.id,
        c.name,
        c.is_group,
        c.is_task_group,
        c.group_photo,
        c.created_at,
        cm.is_pinned,
        cm.role,
        (
          SELECT json_agg(
            json_build_object(
              'id', u.id,
              'name', u.name,
              'phone', u.phone,
              'profile_photo', u.profile_photo
            )
          )
          FROM conversation_members cm2
          JOIN users u ON cm2.user_id = u.id
          WHERE cm2.conversation_id = c.id AND cm2.user_id != $1
        ) as other_members,
        (
          SELECT COUNT(*)::integer
          FROM conversation_members cm3
          WHERE cm3.conversation_id = c.id
        ) as member_count,
        (
          SELECT content
          FROM messages
          WHERE conversation_id = c.id AND deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        ) as last_message,
        (
          SELECT created_at
          FROM messages
          WHERE conversation_id = c.id AND deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        ) as last_message_time,
        (
          CASE 
            WHEN c.is_group = TRUE OR c.is_task_group = TRUE THEN
              -- For group conversations: check message_status table (per-user status)
              (
                SELECT COUNT(*)
                FROM messages m
                LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = $1
                WHERE m.conversation_id = c.id
                AND m.sender_id != $1
                AND (ms.status IS NULL OR ms.status != 'read')
                AND m.is_deleted = FALSE
                AND m.deleted_at IS NULL
              )
            ELSE
              -- For direct conversations: check messages.status
              (
                SELECT COUNT(*)
                FROM messages
                WHERE conversation_id = c.id
                AND sender_id != $1
                AND status != 'read'
                AND deleted_at IS NULL
              )
          END
        ) as unread_count
      FROM conversations c
      INNER JOIN conversation_members cm ON c.id = cm.conversation_id
      WHERE cm.user_id = $1
      ORDER BY cm.is_pinned DESC, last_message_time DESC NULLS LAST, c.created_at DESC`,
      [userId]
    );

    res.json({ conversations: result.rows });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create or get 1-to-1 conversation (used by mobile NewChatScreen)
router.post('/create', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { otherUserId } = req.body;

    if (!otherUserId) {
      return res.status(400).json({ error: 'otherUserId is required' });
    }

    if (userId === otherUserId) {
      return res.status(400).json({ error: 'Cannot create conversation with yourself' });
    }

    // Check if conversation already exists (non-group)
    const existing = await pool.query(
      `SELECT c.id
       FROM conversations c
       INNER JOIN conversation_members cm1 ON c.id = cm1.conversation_id
       INNER JOIN conversation_members cm2 ON c.id = cm2.conversation_id
       WHERE cm1.user_id = $1 AND cm2.user_id = $2 AND c.is_group = FALSE`,
      [userId, otherUserId]
    );

    if (existing.rows.length > 0) {
      return res.json({ conversationId: existing.rows[0].id });
    }

    // Create new conversation
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const convResult = await client.query(
        'INSERT INTO conversations (is_group, created_by) VALUES (FALSE, $1) RETURNING id',
        [userId]
      );
      const conversationId = convResult.rows[0].id;

      await client.query(
        'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)',
        [conversationId, userId, 'member']
      );

      await client.query(
        'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)',
        [conversationId, otherUserId, 'member']
      );

      await client.query('COMMIT');

      res.status(201).json({ conversationId });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Create conversation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create manual group
router.post('/groups/create', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { name, memberIds, group_photo } = req.body;

    if (!name || !Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ error: 'Group name and at least one member required' });
    }

    // Add creator to members if not included
    if (!memberIds.includes(userId)) {
      memberIds.push(userId);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create group conversation
      const convResult = await client.query(
        `INSERT INTO conversations (name, is_group, group_photo, created_by)
         VALUES ($1, TRUE, $2, $3)
         RETURNING id`,
        [name, group_photo || null, userId]
      );
      const conversationId = convResult.rows[0].id;

      // Add members (creator as admin, others as members)
      for (const memberId of memberIds) {
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
  } catch (error) {
    console.error('Create group error:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// Create auto task group
router.post('/groups/task-group', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { taskId, name, memberIds } = req.body;

    if (!taskId || !name || !Array.isArray(memberIds)) {
      return res.status(400).json({ error: 'Task ID, name, and member IDs required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create task group conversation
      const convResult = await client.query(
        `INSERT INTO conversations (name, is_group, is_task_group, task_id, created_by)
         VALUES ($1, TRUE, TRUE, $2, $3)
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
  } catch (error) {
    console.error('Create task group error:', error);
    res.status(500).json({ error: 'Failed to create task group' });
  }
});

// Add members to group
router.post('/groups/:conversationId/members', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { conversationId } = req.params;
    const { memberIds } = req.body;

    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ error: 'Member IDs array required' });
    }

    // Verify user is member of group
    const memberCheck = await pool.query(
      'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    // Verify it's a group
    const convCheck = await pool.query(
      'SELECT is_group FROM conversations WHERE id = $1',
      [conversationId]
    );

    if (!convCheck.rows[0]?.is_group) {
      return res.status(400).json({ error: 'Not a group conversation' });
    }

    // Add members
    for (const memberId of memberIds) {
      await pool.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [conversationId, memberId]
      );
    }

    res.json({ success: true, added: memberIds.length });
  } catch (error) {
    console.error('Add members error:', error);
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// Remove member from group
// Allows users to leave the group themselves (self-removal)
// For removing others: admins can remove any member, regular members cannot remove others
router.delete('/groups/:conversationId/members/:memberId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { conversationId, memberId } = req.params;

    // Verify user is member
    const memberCheck = await pool.query(
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
      await pool.query(
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
    const targetMemberCheck = await pool.query(
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
    await pool.query(
      'DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, memberId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// Update group (name, photo) - admin only
router.put('/groups/:conversationId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { conversationId } = req.params;
    const { name, group_photo } = req.body;

    // Verify user is admin
    const memberCheck = await pool.query(
      'SELECT role FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0 || memberCheck.rows[0].role !== 'admin') {
      return res.status(403).json({ error: 'Only group admin can update group' });
    }

    const updates = [];
    const values = [];
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

    await pool.query(
      `UPDATE conversations SET ${updates.join(', ')} WHERE id = $${paramCount}`,
      values
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Update group error:', error);
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// Pin/Unpin conversation
router.put('/:conversationId/pin', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { conversationId } = req.params;
    const { is_pinned } = req.body;

    await pool.query(
      `UPDATE conversation_members
       SET is_pinned = $1
       WHERE conversation_id = $2 AND user_id = $3`,
      [is_pinned === true, conversationId, userId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Pin conversation error:', error);
    res.status(500).json({ error: 'Failed to pin conversation' });
  }
});

// Get conversation details
router.get('/:conversationId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { conversationId } = req.params;

    // Verify user is member
    const memberCheck = await pool.query(
      'SELECT role, is_pinned FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    // Get conversation details with member count
    const convResult = await pool.query(
      `SELECT c.*, 
        (SELECT COUNT(*)::integer FROM conversation_members cm3 WHERE cm3.conversation_id = c.id) as member_count
       FROM conversations c
       WHERE c.id = $1`,
      [conversationId]
    );

    // Get members with roles
    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.phone, u.profile_photo, cm.role, cm.joined_at
       FROM conversation_members cm
       JOIN users u ON cm.user_id = u.id
       WHERE cm.conversation_id = $1
       ORDER BY cm.role DESC, cm.joined_at ASC`,
      [conversationId]
    );

    res.json({
      conversation: convResult.rows[0],
      members: membersResult.rows,
      userRole: memberCheck.rows[0].role,
      isPinned: memberCheck.rows[0].is_pinned,
    });
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Backwards-compatible: Get all users (for creating new 1-to-1 conversations)
router.get('/users/list', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const userRole = req.user.role;

    // If user is not super_admin, exclude super_admin users from results
    const roleFilter = userRole === 'super_admin' 
      ? '' 
      : " AND role != 'super_admin'";

    const result = await pool.query(
      `SELECT id, name, phone FROM users WHERE id != $1${roleFilter} ORDER BY name`,
      [userId]
    );

    res.json({ users: result.rows });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

