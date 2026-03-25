const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

// Routes
const authRoutes = require('./routes/auth');
const conversationRoutes = require('./routes/conversations');
const messageRoutes = require('./routes/messages');
const contactRoutes = require('./routes/contacts');
const taskRoutes = require('./routes/tasks');
const { handleSocketConnection } = require('./socket/socketHandler');

const app = express();
const server = http.createServer(app);

// Socket.IO setup
const isProduction = process.env.NODE_ENV === 'production';
const getCorsOrigins = () => {
  if (isProduction) {
    const corsOrigin = process.env.SOCKET_CORS_ORIGIN;
    if (!corsOrigin) {
      console.error('❌ SOCKET_CORS_ORIGIN must be set in production');
      process.exit(1);
    }
    return corsOrigin.split(',').map(origin => origin.trim());
  }
  return process.env.SOCKET_CORS_ORIGIN?.split(',').map(origin => origin.trim()) || '*';
};

const corsOrigins = getCorsOrigins();

const io = new Server(server, {
  cors: {
    origin: isProduction ? corsOrigins : '*', // In production, restrict to specific origins
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  },
});

const morgan = require('morgan');

// Middleware
app.use(morgan('dev')); // API Logging
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased for media uploads
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Make io available to routes
app.set('io', io);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/admin', require('./routes/admin'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Fallback 404 handler (also logs unknown routes for debugging)
app.use((req, res) => {
  console.error('404 Not Found:', req.method, req.originalUrl);
  res.status(404).json({ error: 'Not found' });
});

// Socket.IO connection handling
handleSocketConnection(io);

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Socket.IO server ready`);
});

