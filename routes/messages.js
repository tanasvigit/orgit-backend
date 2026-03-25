const express = require('express');
const pool = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get messages for a conversation (with replies, reactions)
router.get('/:conversationId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { conversationId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    // Verify user is member
    const memberCheck = await pool.query(
      'SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    // Get messages with reactions and reply info
    const result = await pool.query(
      `SELECT 
        m.id,
        m.conversation_id,
        m.sender_id,
        m.content,
        m.message_type,
        m.media_url,
        m.media_thumbnail,
        m.file_name,
        m.file_size,
        m.duration,
        m.reply_to_message_id,
        m.edited_at,
        m.deleted_at,
        m.deleted_for_all,
        m.location_lat,
        m.location_lng,
        m.location_address,
        m.is_live_location,
        COALESCE(ms.status, 'sent') as status,
        m.created_at,
        u.name as sender_name,
        u.profile_photo as sender_photo,
        (
          SELECT json_agg(
            json_build_object(
              'id', mr.id,
              'user_id', mr.user_id,
              'reaction', mr.reaction,
              'user_name', u2.name
            )
          )
          FROM message_reactions mr
          JOIN users u2 ON mr.user_id = u2.id
          WHERE mr.message_id = m.id
        ) as reactions,
        (
          SELECT json_build_object(
            'id', rm.id,
            'content', rm.content,
            'sender_name', u3.name,
            'message_type', rm.message_type
          )
          FROM messages rm
          JOIN users u3 ON rm.sender_id = u3.id
          WHERE rm.id = m.reply_to_message_id
        ) as reply_to
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = $2
      WHERE m.conversation_id = $1
        AND (m.deleted_at IS NULL OR m.deleted_for_all = FALSE OR m.sender_id = $2)
      ORDER BY m.created_at DESC
      LIMIT $3 OFFSET $4`,
      [conversationId, userId, limit, offset]
    );

    res.json({ messages: result.rows.reverse() });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Search messages (global or chat-level)
router.get('/search/:conversationId?', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { conversationId } = req.params;
    const { query, limit = 50 } = req.query;

    if (!query) {
      return res.status(400).json({ error: 'Search query required' });
    }

    let searchQuery;
    let params;

    if (conversationId) {
      // Chat-level search
      // Verify user is member
      const memberCheck = await pool.query(
        'SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, userId]
      );

      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'Not a member of this conversation' });
      }

      searchQuery = `
        SELECT m.*, u.name as sender_name
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        JOIN message_search ms ON m.id = ms.message_id
        WHERE ms.conversation_id = $1
          AND ms.content_tsvector @@ plainto_tsquery('english', $2)
          AND (m.deleted_at IS NULL OR m.deleted_for_all = FALSE OR m.sender_id = $3)
        ORDER BY m.created_at DESC
        LIMIT $4
      `;
      params = [conversationId, query, userId, limit];
    } else {
      // Global search (across all user's conversations)
      searchQuery = `
        SELECT m.*, u.name as sender_name, c.name as conversation_name, c.is_group
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        JOIN conversations c ON m.conversation_id = c.id
        JOIN conversation_members cm ON c.id = cm.conversation_id
        JOIN message_search ms ON m.id = ms.message_id
        WHERE cm.user_id = $1
          AND ms.content_tsvector @@ plainto_tsquery('english', $2)
          AND (m.deleted_at IS NULL OR m.deleted_for_all = FALSE OR m.sender_id = $1)
        ORDER BY m.created_at DESC
        LIMIT $3
      `;
      params = [userId, query, limit];
    }

    const result = await pool.query(searchQuery, params);
    res.json({ messages: result.rows });
  } catch (error) {
    console.error('Search messages error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Add reaction to message
router.post('/:messageId/reactions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { messageId } = req.params;
    const { reaction } = req.body;

    if (!reaction) {
      return res.status(400).json({ error: 'Reaction required' });
    }

    await pool.query(
      `INSERT INTO message_reactions (message_id, user_id, reaction)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id, reaction) DO NOTHING`,
      [messageId, userId, reaction]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Add reaction error:', error);
    res.status(500).json({ error: 'Failed to add reaction' });
  }
});

// Remove reaction
router.delete('/:messageId/reactions/:reaction', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { messageId, reaction } = req.params;

    await pool.query(
      'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND reaction = $3',
      [messageId, userId, reaction]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Remove reaction error:', error);
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
});

// Star/Favorite message
router.post('/:messageId/star', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { messageId } = req.params;

    await pool.query(
      `INSERT INTO starred_messages (user_id, message_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [userId, messageId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Star message error:', error);
    res.status(500).json({ error: 'Failed to star message' });
  }
});

// Unstar message
router.delete('/:messageId/star', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { messageId } = req.params;

    await pool.query(
      'DELETE FROM starred_messages WHERE user_id = $1 AND message_id = $2',
      [userId, messageId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Unstar message error:', error);
    res.status(500).json({ error: 'Failed to unstar message' });
  }
});

// Get starred messages
router.get('/starred/all', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(
      `SELECT m.*, u.name as sender_name, c.name as conversation_name
       FROM starred_messages sm
       JOIN messages m ON sm.message_id = m.id
       JOIN users u ON m.sender_id = u.id
       JOIN conversations c ON m.conversation_id = c.id
       WHERE sm.user_id = $1
         AND (m.deleted_at IS NULL OR m.deleted_for_all = FALSE)
       ORDER BY sm.created_at DESC`,
      [userId]
    );

    res.json({ messages: result.rows });
  } catch (error) {
    console.error('Get starred messages error:', error);
    res.status(500).json({ error: 'Failed to get starred messages' });
  }
});

// Edit message
router.put('/:messageId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { messageId } = req.params;
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Content required' });
    }

    // Verify message belongs to user
    const messageCheck = await pool.query(
      'SELECT id FROM messages WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL',
      [messageId, userId]
    );

    if (messageCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Message not found or cannot be edited' });
    }

    await pool.query(
      `UPDATE messages
       SET content = $1, edited_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [content, messageId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Edit message error:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// Delete message
router.delete('/:messageId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { messageId } = req.params;
    const { deleteForAll } = req.body;

    // Verify message belongs to user
    const messageCheck = await pool.query(
      'SELECT id, conversation_id FROM messages WHERE id = $1 AND sender_id = $2',
      [messageId, userId]
    );

    if (messageCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Message not found' });
    }

    if (deleteForAll === true) {
      // Delete for everyone
      await pool.query(
        `UPDATE messages
         SET deleted_at = CURRENT_TIMESTAMP, deleted_for_all = TRUE, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [messageId]
      );
    } else {
      // Delete for self only (soft delete)
      await pool.query(
        `UPDATE messages
         SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [messageId]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// Mark messages as read
router.put('/:conversationId/read', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { conversationId } = req.params;

    // Verify user is member
    const memberCheck = await pool.query(
      'SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this conversation' });
    }

    // Check if this is a group conversation
    const convInfoResult = await pool.query(
      `SELECT is_group, is_task_group FROM conversations WHERE id = $1`,
      [conversationId]
    );
    const isGroup = convInfoResult.rows[0]?.is_group || convInfoResult.rows[0]?.is_task_group || false;

    if (isGroup) {
      // Group chat: Only update message_status table, NOT messages.status
      // Get all unread messages for this user in this conversation
      const unreadMessages = await pool.query(
        `SELECT m.id 
         FROM messages m
         LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = $2
         WHERE m.conversation_id = $1 
         AND m.sender_id != $2 
         AND (ms.status IS NULL OR ms.status != 'read')
         AND m.is_deleted = false
         AND m.deleted_at IS NULL`,
        [conversationId, userId]
      );
      
      // Update message_status table for each unread message
      for (const msg of unreadMessages.rows) {
        try {
          await pool.query(
            `INSERT INTO message_status (message_id, user_id, status, status_at)
             VALUES ($1, $2, 'read', NOW())
             ON CONFLICT (message_id, user_id) 
             DO UPDATE SET status = 'read', status_at = NOW()`,
            [msg.id, userId]
          );
        } catch (error) {
          // If error is about column name, try with created_at
          if (error.message && error.message.includes('created_at')) {
            await pool.query(
              `INSERT INTO message_status (message_id, user_id, status, created_at)
               VALUES ($1, $2, 'read', NOW())
               ON CONFLICT (message_id, user_id) 
               DO UPDATE SET status = 'read', updated_at = NOW()`,
              [msg.id, userId]
            );
          } else {
            console.warn('[markMessagesAsRead] Could not update message_status table:', error.message);
          }
        }
      }
    } else {
      // Direct chat: Update both messages.status and message_status table
      await pool.query(
        `UPDATE messages 
         SET status = 'read' 
         WHERE conversation_id = $1 
         AND sender_id != $2 
         AND status != 'read'
         AND deleted_at IS NULL`,
        [conversationId, userId]
      );
      
      // Get all updated message IDs
      const updatedMessages = await pool.query(
        `SELECT id FROM messages 
         WHERE conversation_id = $1 
         AND sender_id != $2 
         AND status = 'read'
         AND deleted_at IS NULL`,
        [conversationId, userId]
      );
      
      // Update message_status table for each message
      for (const msg of updatedMessages.rows) {
        try {
          await pool.query(
            `INSERT INTO message_status (message_id, user_id, status, status_at)
             VALUES ($1, $2, 'read', NOW())
             ON CONFLICT (message_id, user_id) 
             DO UPDATE SET status = 'read', status_at = NOW()`,
            [msg.id, userId]
          );
        } catch (error) {
          // If error is about column name, try with created_at
          if (error.message && error.message.includes('created_at')) {
            await pool.query(
              `INSERT INTO message_status (message_id, user_id, status, created_at)
               VALUES ($1, $2, 'read', NOW())
               ON CONFLICT (message_id, user_id) 
               DO UPDATE SET status = 'read', updated_at = NOW()`,
              [msg.id, userId]
            );
          } else {
            console.warn('[markMessagesAsRead] Could not update message_status table:', error.message);
          }
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

