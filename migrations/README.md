# Database migrations

This project uses **plain SQL files** in `migrations/`, applied by Node scripts (not Prisma or Flyway). Applied files are tracked in the `schema_migrations` table so commands are safe to re-run.

## Prerequisites

- PostgreSQL 12+
- Dependencies installed: `npm install` (from `orgit-backend/`)
- `.env` in the backend root with database credentials:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=orgit
DB_USER=postgres
DB_PASSWORD=your_password
```

All migration commands read **only** these variables.

---

## Quick reference

| Command | Purpose |
|---------|---------|
| `npm run db:bootstrap` | **New empty database** — applies `database/schema.sql` + all `migrations/*.sql` |
| `npm run migrate` | **Existing database** — applies only **pending** migration files |
| `npm run migrate:status` | List applied vs pending migrations |
| `npm run migrate:baseline` | **Existing DB, empty tracking** — mark all current files as applied **without** running SQL |
| `npm run migrate:create -- <name>` | Create a new timestamped `.sql` file in `migrations/` |

Aliases: `npm run db:all-in-one` = `npm run db:bootstrap`.

---

## Scenario A: Brand-new database

Use this when PostgreSQL has an **empty** database (no tables yet).

### 1. Create the database

```sql
CREATE DATABASE orgit;
```

### 2. Configure `.env`

Point `DB_NAME` (and host/user/password) at that database.

### 3. Bootstrap schema + migrations

```bash
cd orgit-backend
npm run db:bootstrap
```

This will:

1. Create `schema_migrations` if missing  
2. Apply `database/schema.sql` (core tables)  
3. Apply every `migrations/*.sql` file in **filename sort order**  
4. Record each file in `schema_migrations` (skipped on later runs)

### 4. Verify

```bash
npm run migrate:status
```

You should see all migration files as applied.

### 5. Start the API

```bash
npm run dev
```

---

## Scenario B: Existing database (already has schema)

Do **not** use `db:bootstrap` on a database that already has tables — it reapplies the base schema and can cause conflicts.

### 1. Configure `.env`

Point at the existing database.

### 2. Check status

```bash
npm run migrate:status
```

### 3. Choose a path

#### B1 — Schema is current, but `schema_migrations` is missing or incomplete

Common after manual SQL or restores. Mark files as applied without re-running them:

```bash
npm run migrate:baseline
npm run migrate
```

`migrate` then runs only **new** migration files added after the baseline.

#### B2 — Tracking is correct; you only need new migrations

```bash
npm run migrate
```

#### B3 — Unsure

1. Run `migrate:status`.  
2. If hundreds of files show as pending but the DB already has everything → `migrate:baseline`, then `migrate`.  
3. If only a few recent files are pending → `migrate` only.

### 4. Before production

- Take a backup (`pg_dump`).  
- Run migrations on staging first.  
- Confirm `npm run migrate:status` shows no unexpected pending files.

---

## How migrations work

```
migrations/
  ├── add-task-assignees-status-column.sql
  ├── 20260515120000_add-org-field-values-to-memberships.sql
  └── ...
```

- Files are sorted by **filename** (lexicographic). Prefer timestamp prefixes for new files: `npm run migrate:create`.  
- Each file runs inside a **transaction** (rollback on error).  
- Applied filenames are stored in:

```sql
SELECT * FROM schema_migrations ORDER BY filename;
```

- SQL should be **idempotent** when possible (`ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, etc.).

### Base schema vs migrations

| Layer | Location | When |
|-------|----------|------|
| Base schema | `database/schema.sql` | Fresh install via `db:bootstrap` only |
| Incremental changes | `migrations/*.sql` | Every environment via `migrate` or bootstrap |

---

## Creating a new migration

```bash
npm run migrate:create -- add-my-feature
```

Creates something like:

`migrations/20260519120000_add-my-feature.sql`

Edit the file, then on each environment:

```bash
npm run migrate
```

Example template:

```sql
-- add-my-feature
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS my_column VARCHAR(100);

COMMENT ON COLUMN tasks.my_column IS 'Short description';
```

---

## Legacy one-off scripts (optional)

Older setups may have used targeted scripts. The normal path is **`npm run migrate`**, which runs all pending files in `migrations/`.

| Script | npm command |
|--------|-------------|
| Entity master | `npm run migrate:entity-master` |
| Employee master | `npm run migrate:employee-master` |
| Task services | `npm run migrate:task-services` |
| Entity list | `npm run migrate:entity-list` |
| Document instance on tasks | `npm run migrate:document-instance-id` |
| User documents | `npm run migrate:user-documents` |
| Org field values | `npm run migrate:org-field-values` |
| Repair client entities columns | `npm run migrate:repair-client-entities` |
| Fix branches | `npm run migrate:fix-branches` |
| Fix mobile normalization | `npm run migrate:fix-mobile` |
| Run all legacy runners | `npm run migrate:all` |

Prefer adding a new file under `migrations/` and using `npm run migrate` for new work.

---

## Troubleshooting

### `relation "schema_migrations" does not exist`

Run once:

```bash
npm run migrate
```

(or `db:bootstrap` on a fresh DB). The first run creates the tracking table.

### Migration fails mid-way

The failed file is rolled back. Fix the SQL, then run `npm run migrate` again. Do not use `migrate:baseline` until the database actually matches what the migration would have done.

### `already exists` errors

Usually the DB already has the object but `schema_migrations` does not list that file. Use `migrate:baseline` if the full schema is already present, then `migrate` for anything new.

### Connection / timeout errors

- Check PostgreSQL is running.  
- Verify `.env` credentials.  
- Large migrations use a 5-minute statement timeout; split huge changes into smaller files if needed.

### Wrong database

Double-check `DB_NAME` in `.env` before running any command.

---

## Backup and restore

**Backup before migrating production:**

```bash
pg_dump -U postgres -h localhost -d orgit -F c -f orgit_backup.dump
```

**Restore:**

```bash
pg_restore -U postgres -h localhost -d orgit --clean --if-exists orgit_backup.dump
```

---

## Related docs

- Base schema overview: [`../database/README.md`](../database/README.md)  
- Environment variables: `ENV_SETUP.md` (if present in repo root)  
- Main backend README: [`../README.md`](../README.md)
