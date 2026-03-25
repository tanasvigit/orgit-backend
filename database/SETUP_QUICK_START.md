# Database Setup - Quick Start Guide

## Complete Setup Process for New Database

Follow these steps in order when creating a new database:

### Step 1: Create Database
```bash
psql -U postgres -c "CREATE DATABASE orgit;"
```

### Step 2: Configure Environment
Create `.env` file with database credentials (see `ENV_SETUP.md`)

### Step 3: Run Base Schema
```bash
psql -U postgres -d orgit -f database/schema.sql
```
✅ This creates all base tables

### Step 4: Run Migrations
```bash
npm run migrate
```
✅ This applies incremental changes

### Step 5: Run Setup Scripts
```bash
node create-orgs-for-admins.js
node assign-super-admin.js  # Optional
```
✅ This sets up initial data

### Step 6: Verify
```bash
npm run dev
```
✅ Check for "Database connected successfully" message

## What Each Step Does

| Step | What It Does | When to Run |
|------|--------------|-------------|
| **Base Schema** | Creates all core tables (users, tasks, messages, etc.) | Once per new database |
| **Migrations** | Applies incremental changes (new columns, new tables) | After base schema, and whenever new migrations are added |
| **Setup Scripts** | Creates initial data (orgs for admins, super admin) | After migrations |

## Important Notes

- ⚠️ **Base schema must be run BEFORE migrations**
- ⚠️ **Migrations assume base tables already exist**
- ✅ Base schema uses `IF NOT EXISTS` - safe to run multiple times
- ✅ Migrations are incremental - can be run multiple times safely

## Troubleshooting

**Error: "relation does not exist"**
→ Base schema not run yet. Run `database/schema.sql` first.

**Error: "column already exists"**
→ Migration already applied. This is usually safe to ignore.

**Error: "database connection failed"**
→ Check `.env` file and PostgreSQL service status.

