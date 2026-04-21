import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import authRoutes from './routes/authRoutes';
import messageRoutes from './routes/messageRoutes';
import groupRoutes from './routes/groupRoutes';
import taskRoutes from './routes/taskRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import notificationRoutes from './routes/notificationRoutes';
import organizationRoutes from './routes/organizationRoutes';
import documentTemplateRoutes from './routes/documentTemplateRoutes';
import documentRoutes from './routes/documentRoutes';
import documentInstanceRoutes from './routes/documentInstanceRoutes';
import userDocumentRoutes from './routes/userDocumentRoutes';
import complianceRoutes from './routes/complianceRoutes';
import taskMonitoringRoutes from './routes/taskMonitoringRoutes';
import superAdminDashboardRoutes from './routes/superAdminDashboardRoutes';
import userRoutes from './routes/userRoutes';
import platformSettingsRoutes from './routes/platformSettingsRoutes';
import chatUserRoutes from './routes/chatUserRoutes';
import conversationRoutes from './routes/conversationRoutes';
import contactRoutes from './routes/contactRoutes';
import masterDataRoutes from './routes/masterDataRoutes';
import clientEntityRoutes from './routes/clientEntityRoutes';
import organizationEntityRoutes from './routes/organizationEntityRoutes';
import entityMasterBulkRoutes from './routes/entityMasterBulkRoutes';
import adminTaskServiceRoutes from './routes/adminTaskServiceRoutes';
import taskBulkRoutes from './routes/taskBulkRoutes';
import uploadRoutes from './routes/uploadRoutes';
import { setupMessageHandlers } from './socket/messageHandlers';
import { getValidatedDeviceTimestamp } from './utils/deviceTime';
import { setupTaskJobs } from './jobs/taskJobs';
import path from 'path';

dotenv.config();

// Environment validation
const isProduction = process.env.NODE_ENV === 'production';
const requiredEnvVars = ['JWT_SECRET', 'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];

if (isProduction) {
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables in production:');
    missingVars.forEach(varName => console.error(`   - ${varName}`));
    process.exit(1);
  }
} else {
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
  if (missingVars.length > 0) {
    console.warn('⚠️  Missing environment variables (using defaults):');
    missingVars.forEach(varName => console.warn(`   - ${varName}`));
  }
}

const app = express();
const httpServer = createServer(app);

// CORS configuration
const getCorsOrigins = () => {
  if (isProduction) {
    // In production, require SOCKET_CORS_ORIGIN to be set
    const corsOrigin = process.env.SOCKET_CORS_ORIGIN;
    if (!corsOrigin) {
      console.error('❌ SOCKET_CORS_ORIGIN must be set in production');
      process.exit(1);
    }
    return corsOrigin.split(',').map(origin => origin.trim());
  }
  // Development: Allow common development origins
  return process.env.SOCKET_CORS_ORIGIN?.split(',').map(origin => origin.trim()) || [
    'http://localhost:',
    'http://localhost:19006',
    'http://localhost:8081',
    'exp://localhost:8081',
    /^exp:\/\/.*/,
    /^http:\/\/localhost:.*/,
  ];
};

const allowedOrigins = getCorsOrigins();

const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, etc.)
      if (!origin) {
        callback(null, true);
        return;
      }

      // In production, strictly validate origins
      if (isProduction) {
        const isAllowed = allowedOrigins.some(allowed => {
          if (typeof allowed === 'string') {
            return origin === allowed;
          }
          if (allowed instanceof RegExp) {
            return allowed.test(origin);
          }
          return false;
        });

        if (isAllowed) {
          callback(null, true);
        } else {
          console.warn(`⚠️  Blocked CORS request from origin: ${origin}`);
          callback(new Error('Not allowed by CORS'));
        }
      } else {
        // Development: More permissive
        const isAllowed = allowedOrigins.some(allowed => {
          if (typeof allowed === 'string') {
            return origin === allowed || origin.startsWith(allowed);
          }
          if (allowed instanceof RegExp) {
            return allowed.test(origin);
          }
          return false;
        });
        callback(null, isAllowed);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  },
  transports: ['polling', 'websocket'], // Try polling first (more reliable for mobile)
  allowEIO3: true, // Allow Engine.IO v3 clients
  pingTimeout: 60000, // Increase ping timeout
  pingInterval: 25000, // Increase ping interval
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:", "http://localhost:3000/"],
      frameSrc: ["'self'", "blob:", "http://localhost:3000/"],
      objectSrc: ["'self'", "blob:", "http://localhost:3000/"],
      frameAncestors: ["'self'", "http://localhost:3000/"],
      upgradeInsecureRequests: null,
    },
  },
  frameguard: false, // Allow iframes for PDF preview
}));

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) {
      callback(null, true);
      return;
    }

    // Use the same validation logic as Socket.IO
    const isAllowed = allowedOrigins.some(allowed => {
      if (typeof allowed === 'string') {
        if (isProduction) {
          return origin === allowed;
        }
        return origin === allowed || origin.startsWith(allowed);
      }
      if (allowed instanceof RegExp) {
        return allowed.test(origin);
      }
      return false;
    });

    if (isAllowed || !isProduction) {
      callback(null, true);
    } else {
      console.warn(`⚠️  Blocked CORS request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Static files for PDF previews
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

import morgan from 'morgan';
app.use(morgan('dev'));

// Increase body size limits for file uploads
// Note: Multer handles multipart/form-data separately, but we increase JSON/URL-encoded limits
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Device timestamp middleware: attach validated device time to request
app.use((req, _res, next) => {
  const headerTs = (req.headers['x-device-timestamp'] as string | undefined) || undefined;
  const bodyTs =
    typeof (req as any).body?.deviceTimestamp === 'string'
      ? (req as any).body.deviceTimestamp
      : undefined;

  const validated = getValidatedDeviceTimestamp(headerTs || bodyTs || null);
  (req as any).deviceTime = validated;
  next();
});

// Increase server timeout for file uploads (default is 2 minutes)
httpServer.timeout = 5 * 60 * 1000; // 5 minutes
httpServer.keepAliveTimeout = 5 * 60 * 1000; // 5 minutes

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/document-instances', documentInstanceRoutes);
app.use('/api/user-documents', userDocumentRoutes);
app.use('/api/chat/users', chatUserRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/upload', uploadRoutes);

// Organization endpoints (accessible by all authenticated users with organization)
import { authenticate } from './middleware/authMiddleware';
import * as organizationController from './controllers/organizationController';
import * as clientEntityController from './controllers/clientEntityController';
app.get('/api/organization/data', authenticate, organizationController.getMyOrganizationData);
app.get('/api/organization/task-services', authenticate, clientEntityController.getOrganizationTaskServices);
// Client-service matrix for current user's organization (accessible to all org members)
app.get('/api/organization/client-matrix', authenticate, clientEntityController.getClientServiceMatrix);

// Master data (countries, states, cities, org-constitutions) - authenticated
app.use('/api/master', masterDataRoutes);

// Organization-scoped client entities (read-only, all org members)
app.use('/api/organization/entities', organizationEntityRoutes);

// Super Admin Routes
app.use('/api/super-admin/organizations', organizationRoutes);
app.use('/api/super-admin/document-templates', documentTemplateRoutes);
app.use('/api/super-admin/tasks', taskMonitoringRoutes);
app.use('/api/super-admin/dashboard', superAdminDashboardRoutes);
app.use('/api/super-admin/users', userRoutes);
app.use('/api/super-admin/settings', platformSettingsRoutes);
import adminRoutes from './routes/adminRoutes';
app.use('/api/admin', adminRoutes);

// Admin routes for departments, designations, and employees
import departmentRoutes from './routes/departmentRoutes';
import designationRoutes from './routes/designationRoutes';
import employeeRoutes from './routes/employeeRoutes';
import documentManagementSettingsRoutes from './routes/documentManagementSettingsRoutes';
import { errorHandler } from './middleware/errorHandler';
app.use('/api/admin/departments', departmentRoutes);
app.use('/api/admin/designations', designationRoutes);
app.use('/api/admin/employees', employeeRoutes);
app.use('/api/admin/document-management-settings', documentManagementSettingsRoutes);
app.use('/api/admin/entities', clientEntityRoutes);
app.use('/api/admin/entity-master', entityMasterBulkRoutes);
app.use('/api/admin/task-services', adminTaskServiceRoutes);
app.use('/api/admin/tasks/bulk', taskBulkRoutes);

// Compliance Routes (accessible by both Super Admin and Admin)
app.use('/api/compliance', complianceRoutes);

// Make Socket.IO instance available to routes (matching message-backend pattern)
app.set('io', io);

// Setup Socket.io handlers
setupMessageHandlers(io);

// Error handling middleware (centralized, no stack traces in responses)
app.use(errorHandler);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server run on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  // Setup scheduled jobs
  setupTaskJobs(io);
});

export { io };

