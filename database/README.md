# Database Setup Guide

This guide explains how to set up a new database for the orgit-api backend.

## Prerequisites

- PostgreSQL 12+ installed and running
- Access to create databases and run SQL scripts

## Setup Steps

### 1. Create PostgreSQL Database

```sql
CREATE DATABASE orgit;
```

Or using psql command line:
```bash
psql -U postgres -c "CREATE DATABASE orgit;"
```

### 2. Configure Environment Variables

Create a `.env` file in the project root (see `ENV_SETUP.md` for details):

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=orgit
DB_USER=postgres
DB_PASSWORD=your_password_here
JWT_SECRET=your_jwt_secret_minimum_32_characters
```

### 3. Run Base Schema

Execute the base schema SQL script to create all core tables:

```bash
psql -U postgres -d orgit -f database/schema.sql
```

Or using psql interactively:
```bash
psql -U postgres -d orgit
\i database/schema.sql
```

This creates all base tables including:
- Users, Organizations, User-Organization relationships
- Tasks, Task Assignees, Task Activities
- Conversations, Messages, Message Status
- Document Templates, Document Instances
- Compliance Master
- Notifications, OTP Verifications
- Platform Settings
- And more...

### 4. Run Migrations

After the base schema is created, run incremental migrations:

```bash
npm run migrate
```

This applies additional migrations from the `migrations/` folder:
- `create-departments-table.sql`
- `create-designations-table.sql`
- `add-reporting-member-to-tasks.sql`
- `add-task-assignees-completion-columns.sql`
- `ALTER-messages-sender-org-id-nullable.sql`
- `make-sender-org-id-nullable.sql`

### 5. Run Post-Setup Scripts

**Create Organizations for Admins:**
```bash
node create-orgs-for-admins.js
```
This script creates organizations for any admin users who don't have one.

**Assign Super Admin (Optional):**
```bash
node assign-super-admin.js
```
This interactive script allows you to assign the `super_admin` role to a user by their mobile number.

### 6. Verify Setup

Start the server to verify the database connection:

```bash
npm run dev  # Development mode
# or
npm start    # Production mode
```

You should see:
```
✅ Database connected successfully
Server running on port 3000
```

## Database Structure

### Core Tables
- `users` - User accounts
- `organizations` - Organization details
- `user_organizations` - User-Organization relationships

### Task Management
- `tasks` - Task records
- `task_assignees` - Task assignments
- `task_assignments` - Alternative assignment tracking
- `task_activities` - Activity logs
- `task_status_logs` - Status change history

### Messaging
- `conversations` - Chat conversations
- `conversation_members` - Conversation participants
- `messages` - Messages
- `message_status` - Delivery/read status
- `starred_messages` - Starred messages
- `message_reactions` - Message reactions
- `groups` - Group chats (legacy)
- `group_members` - Group members

### Document Management
- `document_templates` - Document templates
- `document_template_versions` - Template version history
- `document_instances` - Filled document instances

### Compliance
- `compliance_master` - Compliance records

### Other
- `notifications` - User notifications
- `otp_verifications` - OTP verification records
- `platform_settings` - Platform configuration
- `profiles` - User profiles (optional)
- `departments` - Departments (via migration)
- `designations` - Designations (via migration)

## Troubleshooting

### Connection Errors
- Verify PostgreSQL is running: `pg_isready`
- Check database credentials in `.env`
- Ensure database exists: `psql -U postgres -l`

### Migration Errors
- Ensure base schema is created first
- Check if tables already exist (migrations use `IF NOT EXISTS`)
- Review migration files for syntax errors

### Permission Errors
- Ensure database user has CREATE, ALTER, and INSERT permissions
- For production, use a dedicated database user with limited permissions

## Backup and Restore

### Backup
```bash
pg_dump -U postgres orgit > orgit_backup.sql
```

### Restore
```bash
psql -U postgres -d orgit < orgit_backup.sql
```

## Notes

- The base schema uses `IF NOT EXISTS` clauses to prevent errors if tables already exist
- UUIDs are generated using PostgreSQL's `gen_random_uuid()` function
- All timestamps use `CURRENT_TIMESTAMP` as default
- Foreign keys use `ON DELETE CASCADE` or `ON DELETE SET NULL` appropriately
- Indexes are created for frequently queried columns

