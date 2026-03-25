const pool = require('../database/db');
const jwt = require('jsonwebtoken');
const { sendPushToTokens } = require('../services/firebaseAdmin');

const authenticateSocket = (socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    return next(new Error('Authentication error'));
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return next(new Error('Authentication error'));
    }
    socket.userId = decoded.userId;
    next();
  });
};

const handleSocketConnection = (io) => {
  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    console.log(`User ${socket.userId} connected`);

    // Join user's room for personal notifications
    socket.join(`user_${socket.userId}`);

    // Notify others that this user is now online
    socket.broadcast.emit('user_online', { userId: socket.userId });

    // Join conversation rooms
    socket.on('join_conversation', async (conversationId) => {
      try {
        const memberCheck = await pool.query(
          'SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
          [conversationId, socket.userId]
        );

        if (memberCheck.rows.length > 0) {
          socket.join(conversationId);
          console.log(`User ${socket.userId} joined conversation ${conversationId}`);
        }
      } catch (error) {
        console.error('Join conversation error:', error);
      }
    });

    // Leave conversation room
    socket.on('leave_conversation', (conversationId) => {
      socket.leave(conversationId);
      console.log(`User ${socket.userId} left conversation ${conversationId}`);
    });

    // Send message (enhanced with media support)
    socket.on('send_message', async (data) => {
      try {
        const {
          conversationId,
          content,
          messageType = 'text',
          mediaUrl,
          mediaThumbnail,
          fileName,
          fileSize,
          duration,
          replyToMessageId,
          locationLat,
          locationLng,
          locationAddress,
          isLiveLocation,
          liveLocationExpiresAt
        } = data;

        if (!conversationId) {
          socket.emit('error', { message: 'conversationId is required' });
          return;
        }

        // Verify user is member
        const memberCheck = await pool.query(
          'SELECT * FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
          [conversationId, socket.userId]
        );

        if (memberCheck.rows.length === 0) {
          socket.emit('error', { message: 'Not a member of this conversation' });
          return;
        }

        // Save message to database
        const result = await pool.query(
          `INSERT INTO messages (
            conversation_id, sender_id, content, message_type, media_url, media_thumbnail,
            file_name, file_size, duration, reply_to_message_id,
            location_lat, location_lng, location_address, is_live_location, live_location_expires_at,
            status
          )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'sent')
           RETURNING *`,
          [
            conversationId, socket.userId, content, messageType,
            mediaUrl || null, mediaThumbnail || null,
            fileName || null, fileSize || null, duration || null,
            replyToMessageId || null,
            locationLat || null, locationLng || null, locationAddress || null,
            isLiveLocation || false, liveLocationExpiresAt || null
          ]
        );

        const message = result.rows[0];

        // Get sender info
        const userResult = await pool.query(
          'SELECT name, profile_photo FROM users WHERE id = $1',
          [socket.userId]
        );
        message.sender_name = userResult.rows[0].name;
        message.sender_photo = userResult.rows[0].profile_photo;

        // Get reply info if exists
        if (replyToMessageId) {
          const replyResult = await pool.query(
            `SELECT m.id, m.content, m.message_type, u.name as sender_name
             FROM messages m
             JOIN users u ON m.sender_id = u.id
             WHERE m.id = $1`,
            [replyToMessageId]
          );
          if (replyResult.rows.length > 0) {
            message.reply_to = replyResult.rows[0];
          }
        }

        // Get conversation members first
        const conversationMembers = await pool.query(
          'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
          [conversationId]
        );

        // Emit to all members in the conversation room
        io.to(conversationId).emit('new_message', message);
        
        // Also emit to each member's personal room so ConversationsScreen can receive updates
        for (const member of conversationMembers.rows) {
          io.to(`user_${member.user_id}`).emit('new_message', message);
        }

        // Update conversation updated_at
        await pool.query(
          'UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
          [conversationId]
        );

        // Message lifecycle: Sent → Delivered → Read
        // Message starts as 'sent' (already set in INSERT)
        message.status = 'sent';

        // Check which users are online and update to 'delivered' for them
        const otherMembers = await pool.query(
          'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id != $2',
          [conversationId, socket.userId]
        );

        const onlineUsers = [];
        for (const member of otherMembers.rows) {
          const sockets = await io.in(`user_${member.user_id}`).fetchSockets();
          if (sockets.length > 0) {
            onlineUsers.push(member.user_id);
            // Update status to delivered for online users
            await pool.query(
              'UPDATE messages SET status = $1 WHERE id = $2',
              ['delivered', message.id]
            );
          }
        }

        // Emit status update if delivered
        if (onlineUsers.length > 0) {
          message.status = 'delivered';
          io.to(conversationId).emit('message_status_update', {
            messageId: message.id,
            conversationId,
            status: 'delivered',
          });
          
          // Also emit to each member's personal room
          for (const member of conversationMembers.rows) {
            io.to(`user_${member.user_id}`).emit('message_status_update', {
              messageId: message.id,
              conversationId,
              status: 'delivered',
            });
          }
        }

        const senderName = userResult.rows[0].name;
        const notificationBody = content
          ? (content.length > 50 ? content.substring(0, 50) + '...' : content)
          : (messageType === 'image' ? '📷 Photo'
            : messageType === 'video' ? '🎥 Video'
            : messageType === 'audio' || messageType === 'voice' ? '🎤 Audio'
            : messageType === 'document' ? '📄 Document'
            : messageType === 'location' ? '📍 Location'
            : `Sent a ${messageType}`);
        const notificationTitle = `New message from ${senderName}`;

        // Create notifications and send FCM push for offline users
        for (const member of otherMembers.rows) {
          if (!onlineUsers.includes(member.user_id)) {
            await pool.query(
              `INSERT INTO notifications (user_id, type, title, description, related_entity_type, related_entity_id)
               VALUES ($1, 'message_received', $2, $3, $4, $5)`,
              [
                member.user_id,
                notificationTitle,
                notificationBody,
                'conversation',
                conversationId || message.id
              ]
            );
            // Send FCM push (fire-and-forget)
            pool.query('SELECT token FROM user_push_tokens WHERE user_id = $1', [member.user_id])
              .then((tokenResult) => {
                const tokens = (tokenResult.rows || []).map((r) => r.token).filter(Boolean);
                if (tokens.length > 0) {
                  sendPushToTokens(tokens, notificationTitle, notificationBody, {
                    conversationId: String(conversationId),
                    type: 'message'
                  });
                }
              })
              .catch((err) => console.warn('FCM token fetch error:', err.message));
          }
        }
      } catch (error) {
        console.error('Send message error:', error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // Typing indicator
    socket.on('typing', (data) => {
      const { conversationId, isTyping } = data;
      socket.to(conversationId).emit('typing', {
        userId: socket.userId,
        isTyping,
      });
    });

    // Mark message as read (can mark single message or all messages in conversation)
    socket.on('message_read', async (data) => {
      try {
        const { messageId, conversationId } = data;

        if (messageId && conversationId) {
          // Mark single message as read
          const messageCheck = await pool.query(
            `SELECT m.id, m.sender_id
             FROM messages m
             JOIN conversation_members cm ON m.conversation_id = cm.conversation_id
             WHERE m.id = $1 AND m.conversation_id = $2 AND cm.user_id = $3`,
            [messageId, conversationId, socket.userId]
          );

          if (messageCheck.rows.length > 0 && messageCheck.rows[0].sender_id !== socket.userId) {
            await pool.query(
              'UPDATE messages SET status = $1 WHERE id = $2 AND status != $1',
              ['read', messageId]
            );

            io.to(conversationId).emit('message_status_update', {
              messageId,
              conversationId,
              status: 'read',
            });
          }
        } else if (conversationId) {
          // Check if this is a group conversation
          const convInfoResult = await pool.query(
            `SELECT is_group, is_task_group FROM conversations WHERE id = $1`,
            [conversationId]
          );
          const isGroup = convInfoResult.rows[0]?.is_group || convInfoResult.rows[0]?.is_task_group || false;

          // For group chats, only update message_status table (per-user status)
          // For direct chats, update both messages.status and message_status table
          let updatedMessages;
          
          if (isGroup) {
            // Group chat: Only update message_status table, NOT messages.status
            // Get all unread messages for this user in this conversation
            updatedMessages = await pool.query(
              `SELECT m.id 
               FROM messages m
               LEFT JOIN message_status ms ON m.id = ms.message_id AND ms.user_id = $2
               WHERE m.conversation_id = $1 
               AND m.sender_id != $2 
               AND (ms.status IS NULL OR ms.status != 'read')
               AND m.is_deleted = false
               AND m.deleted_at IS NULL`,
              [conversationId, socket.userId]
            );
            
            // Update message_status table for each unread message
            for (const msg of updatedMessages.rows) {
              try {
                await pool.query(
                  `INSERT INTO message_status (message_id, user_id, status, status_at)
                   VALUES ($1, $2, 'read', NOW())
                   ON CONFLICT (message_id, user_id) 
                   DO UPDATE SET status = 'read', status_at = NOW()`,
                  [msg.id, socket.userId]
                );
              } catch (error) {
                // If error is about column name, try with created_at
                if (error.message && error.message.includes('created_at')) {
                  await pool.query(
                    `INSERT INTO message_status (message_id, user_id, status, created_at)
                     VALUES ($1, $2, 'read', NOW())
                     ON CONFLICT (message_id, user_id) 
                     DO UPDATE SET status = 'read', updated_at = NOW()`,
                    [msg.id, socket.userId]
                  );
                } else {
                  console.warn('[message_read] Could not update message_status table:', error.message);
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
              [conversationId, socket.userId]
            );

            // Get all updated message IDs
            updatedMessages = await pool.query(
              `SELECT id FROM messages 
               WHERE conversation_id = $1 
               AND sender_id != $2 
               AND status = 'read'
               AND deleted_at IS NULL`,
              [conversationId, socket.userId]
            );
            
            // Update message_status table for each message
            for (const msg of updatedMessages.rows) {
              try {
                await pool.query(
                  `INSERT INTO message_status (message_id, user_id, status, status_at)
                   VALUES ($1, $2, 'read', NOW())
                   ON CONFLICT (message_id, user_id) 
                   DO UPDATE SET status = 'read', status_at = NOW()`,
                  [msg.id, socket.userId]
                );
              } catch (error) {
                // If error is about column name, try with created_at
                if (error.message && error.message.includes('created_at')) {
                  await pool.query(
                    `INSERT INTO message_status (message_id, user_id, status, created_at)
                     VALUES ($1, $2, 'read', NOW())
                     ON CONFLICT (message_id, user_id) 
                     DO UPDATE SET status = 'read', updated_at = NOW()`,
                    [msg.id, socket.userId]
                  );
                } else {
                  console.warn('[message_read] Could not update message_status table:', error.message);
                }
              }
            }
          }

          // Get conversation members to emit to their personal rooms
          const convMembers = await pool.query(
            'SELECT user_id FROM conversation_members WHERE conversation_id = $1',
            [conversationId]
          );
          
          // Emit a single event for all messages marked as read in this conversation
          io.to(conversationId).emit('conversation_messages_read', {
            conversationId,
            status: 'read',
          });
          
          // Also emit to each member's personal room
          for (const member of convMembers.rows) {
            io.to(`user_${member.user_id}`).emit('conversation_messages_read', {
              conversationId,
              status: 'read',
            });
          }
          
          // Also emit individual updates for each message
          for (const msg of updatedMessages.rows) {
            io.to(conversationId).emit('message_status_update', {
              messageId: msg.id,
              conversationId,
              status: 'read',
            });
            
            // Also emit to each member's personal room
            for (const member of convMembers.rows) {
              io.to(`user_${member.user_id}`).emit('message_status_update', {
                messageId: msg.id,
                conversationId,
                status: 'read',
              });
            }
          }
        }
      } catch (error) {
        console.error('Mark read error:', error);
      }
    });

    // Message reaction
    socket.on('message_reaction', async (data) => {
      try {
        const { messageId, conversationId, reaction } = data;

        await pool.query(
          `INSERT INTO message_reactions (message_id, user_id, reaction)
           VALUES ($1, $2, $3)
           ON CONFLICT (message_id, user_id, reaction) DO NOTHING`,
          [messageId, socket.userId, reaction]
        );

        io.to(conversationId).emit('message_reaction_added', {
          messageId,
          userId: socket.userId,
          reaction,
        });
      } catch (error) {
        console.error('Message reaction error:', error);
      }
    });

    // Remove reaction
    socket.on('remove_reaction', async (data) => {
      try {
        const { messageId, conversationId, reaction } = data;

        await pool.query(
          'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND reaction = $3',
          [messageId, socket.userId, reaction]
        );

        io.to(conversationId).emit('message_reaction_removed', {
          messageId,
          userId: socket.userId,
          reaction,
        });
      } catch (error) {
        console.error('Remove reaction error:', error);
      }
    });

    // Check if user is online
    socket.on('check_user_online', (data, callback) => {
      try {
        const { userId } = data;
        // Check if user is in their personal room (connected)
        io.in(`user_${userId}`).fetchSockets().then((sockets) => {
          const isOnline = sockets.length > 0;
          if (callback) {
            callback(isOnline);
          }
          // Also emit the status
          socket.emit('user_online_status', { userId, isOnline });
        });
      } catch (error) {
        console.error('Check user online error:', error);
        if (callback) {
          callback(false);
        }
      }
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`User ${socket.userId} disconnected`);
      // Notify others that this user is now offline
      socket.broadcast.emit('user_offline', { userId: socket.userId });
    });
  });
};

module.exports = { handleSocketConnection };

