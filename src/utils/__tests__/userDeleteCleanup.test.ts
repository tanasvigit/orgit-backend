import {
  cleanupUserDependentRows,
  quoteIdent,
} from '../userDeleteCleanup';

function flattenColumns(tables: Record<string, string[]>) {
  return Object.entries(tables).flatMap(([table_name, columns]) =>
    columns.map((column_name) => ({ table_name, column_name }))
  );
}

describe('userDeleteCleanup', () => {
  const client = {
    query: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('quotes identifiers safely', () => {
    expect(quoteIdent('task_assignments')).toBe('"task_assignments"');
    expect(quoteIdent('weird"name')).toBe('"weird""name"');
  });

  it('uses assigned_* columns when a new database has no task_assignments.user_id', async () => {
    client.query.mockImplementation(async (sql: string) => {
      const q = String(sql);
      if (q.includes('FROM information_schema.columns') && q.includes("table_schema = 'public'")) {
        return {
          rows: flattenColumns({
            users: ['id', 'mobile'],
            task_assignments: ['id', 'task_id', 'assigned_to_user_id', 'assigned_by_user_id'],
            task_assignees: ['id', 'task_id', 'user_id'],
            tasks: ['id', 'creator_id', 'created_by', 'reporting_member_id'],
          }),
        };
      }
      if (q.includes('FROM pg_constraint con')) {
        return {
          rows: [
            {
              table_name: 'task_assignments',
              column_name: 'assigned_to_user_id',
              delete_rule: 'CASCADE',
              is_nullable: 'NO',
            },
            {
              table_name: 'task_assignments',
              column_name: 'assigned_by_user_id',
              delete_rule: 'CASCADE',
              is_nullable: 'NO',
            },
            {
              table_name: 'tasks',
              column_name: 'reporting_member_id',
              delete_rule: 'SET NULL',
              is_nullable: 'YES',
            },
          ],
        };
      }
      return { rows: [] };
    });

    await cleanupUserDependentRows(client, 'user-1');

    const sqlCalls = client.query.mock.calls.map(([sql]) => String(sql));
    const assignmentDelete = sqlCalls.find((sql) =>
      sql.includes('DELETE FROM "task_assignments"')
    );

    expect(assignmentDelete).toContain('"assigned_to_user_id" = $1');
    expect(assignmentDelete).toContain('"assigned_by_user_id" = $1');
    expect(assignmentDelete).not.toContain('"user_id" = $1');
    expect(sqlCalls.some((sql) => sql.includes('DELETE FROM "contacts"'))).toBe(false);
    expect(sqlCalls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('UPDATE "tasks" SET "reporting_member_id" = NULL'),
      ])
    );
  });

  it('uses user_id when that is the column on the connected database', async () => {
    client.query.mockImplementation(async (sql: string) => {
      const q = String(sql);
      if (q.includes('FROM information_schema.columns') && !q.includes('table_constraints')) {
        return {
          rows: flattenColumns({
            users: ['id', 'mobile'],
            task_assignments: ['id', 'task_id', 'user_id'],
          }),
        };
      }
      if (q.includes('FROM pg_constraint con')) {
        return {
          rows: [
            {
              table_name: 'task_assignments',
              column_name: 'user_id',
              delete_rule: 'CASCADE',
              is_nullable: 'NO',
            },
          ],
        };
      }
      return { rows: [] };
    });

    await cleanupUserDependentRows(client, 'user-1');

    const assignmentDelete = client.query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('DELETE FROM "task_assignments"'));

    expect(assignmentDelete).toContain('"user_id" = $1');
    expect(assignmentDelete).not.toContain('assigned_to_user_id');
  });

  it('cleans new-database tables discovered only through foreign keys', async () => {
    client.query.mockImplementation(async (sql: string) => {
      const q = String(sql);
      if (q.includes('FROM information_schema.columns') && !q.includes('table_constraints')) {
        return {
          rows: flattenColumns({
            users: ['id', 'mobile'],
            extra_user_tokens: ['id', 'user_id'],
          }),
        };
      }
      if (q.includes('FROM pg_constraint con')) {
        return {
          rows: [
            {
              table_name: 'extra_user_tokens',
              column_name: 'user_id',
              delete_rule: 'CASCADE',
              is_nullable: 'NO',
            },
          ],
        };
      }
      return { rows: [] };
    });

    await cleanupUserDependentRows(client, 'user-1');

    const sqlCalls = client.query.mock.calls.map(([sql]) => String(sql));
    expect(sqlCalls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('DELETE FROM "extra_user_tokens" WHERE "user_id" = $1'),
      ])
    );
  });

  it('does not delete other users rows when users has a self-FK', async () => {
    client.query.mockImplementation(async (sql: string) => {
      const q = String(sql);
      if (q.includes('FROM information_schema.columns') && !q.includes('table_constraints')) {
        return {
          rows: flattenColumns({
            users: ['id', 'mobile', 'manager_id'],
          }),
        };
      }
      if (q.includes('FROM pg_constraint con')) {
        return {
          rows: [
            {
              table_name: 'users',
              column_name: 'manager_id',
              delete_rule: 'SET NULL',
              is_nullable: 'YES',
            },
          ],
        };
      }
      return { rows: [] };
    });

    await cleanupUserDependentRows(client, 'user-1');

    const sqlCalls = client.query.mock.calls.map(([sql]) => String(sql));
    expect(sqlCalls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('UPDATE "users" SET "manager_id" = NULL WHERE "manager_id" = $1'),
      ])
    );
    expect(sqlCalls.some((sql) => sql.includes('DELETE FROM "users"'))).toBe(false);
  });
});
