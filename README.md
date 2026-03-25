# ORGIT Backend API

Backend server for the ORGIT platform using Node.js, Express, Socket.IO, TypeScript, and PostgreSQL.

## Database Setup

**Important:** When setting up a new database, follow these steps in order:

### 1. Create PostgreSQL Database

```sql
CREATE DATABASE orgit;
```

Or using psql command line:
```bash
psql -U postgres -c "CREATE DATABASE orgit;"
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the project root. See `ENV_SETUP.md` for required variables:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=orgit
DB_USER=postgres
DB_PASSWORD=your_password_here
JWT_SECRET=your_jwt_secret_minimum_32_characters
JWT_EXPIRES_IN=7d
SOCKET_CORS_ORIGIN=http://localhost:3000/
```

### 4. Run Base Schema

Execute the base schema SQL script to create all core tables:

```bash
psql -U postgres -d orgit -f database/schema.sql
```

This creates all base tables (users, organizations, tasks, messages, conversations, documents, etc.).

### 5. Run Migrations

After the base schema is created, run incremental migrations:

```bash
npm run migrate
```

This applies additional migrations from the `migrations/` folder.

### 6. Run Post-Setup Scripts

**Create Organizations for Admins:**
```bash
node create-orgs-for-admins.js
```

**Assign Super Admin (Optional):**
```bash
node assign-super-admin.js
```

### 7. Start the Server

For development with auto-reload:
```bash
npm run dev
```

For production:
```bash
npm start
```

**For detailed database setup instructions, see `database/README.md`**

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/me` - Get current user (requires auth)

### Conversations
- `GET /api/conversations` - Get all conversations for current user
- `POST /api/conversations/create` - Create or get 1-to-1 conversation
- `GET /api/conversations/:conversationId` - Get conversation details
- `GET /api/conversations/users/list` - Get all users (for creating conversations)

### Messages
- `GET /api/messages/:conversationId` - Get messages for a conversation
- `PUT /api/messages/:conversationId/read` - Mark messages as read

## Socket.IO Events

### Client → Server
- `join_conversation` - Join a conversation room
- `leave_conversation` - Leave a conversation room
- `send_message` - Send a message
- `typing` - Send typing indicator
- `message_read` - Mark message as read

### Server → Client
- `new_message` - New message received
- `message_status_update` - Message status changed (delivered/read)
- `typing` - Typing indicator from other user
- `error` - Error occurred

## Environment Variables

- `PORT` - Server port (default: 3000)
- `DB_HOST` - PostgreSQL host
- `DB_PORT` - PostgreSQL port
- `DB_NAME` - Database name
- `DB_USER` - Database user
- `DB_PASSWORD` - Database password
- `JWT_SECRET` - Secret key for JWT tokens

