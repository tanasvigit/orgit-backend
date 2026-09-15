import pool from '../../config/database';
import { deleteUser } from '../userService';

jest.mock('../../config/database', () => ({
  __esModule: true,
  query: jest.fn(),
  default: {
    connect: jest.fn(),
  },
}));

describe('userService.deleteUser', () => {
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (pool.connect as jest.Mock).mockResolvedValue(mockClient);
    mockClient.query.mockImplementation(async (sql: string) => {
      const q = String(sql);
      if (q.includes('FROM information_schema.columns') && !q.includes('table_constraints')) {
        return {
          rows: [
            { table_name: 'users', column_name: 'id' },
            { table_name: 'users', column_name: 'mobile' },
            { table_name: 'task_assignments', column_name: 'assigned_to_user_id' },
            { table_name: 'task_assignments', column_name: 'assigned_by_user_id' },
          ],
        };
      }
      if (q.includes('FROM pg_constraint con')) {
        return { rows: [] };
      }
      return { rows: [] };
    });
  });

  it('deletes using live schema columns and then removes the user', async () => {
    await deleteUser('user-1');

    const sqlCalls = mockClient.query.mock.calls.map(([sql]) => String(sql));
    const assignmentSql = sqlCalls.find((sql) => sql.includes('DELETE FROM "task_assignments"'));

    expect(assignmentSql).toContain('"assigned_to_user_id"');
    expect(assignmentSql).toContain('"assigned_by_user_id"');
    expect(assignmentSql).not.toContain('"user_id"');
    expect(sqlCalls).toContain('DELETE FROM users WHERE id = $1');
    expect(sqlCalls).toContain('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('rolls back on unexpected errors', async () => {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes('DELETE FROM users')) {
        throw Object.assign(new Error('foreign key violation'), { code: '23503' });
      }
      if (String(sql).includes('FROM information_schema.columns') && !String(sql).includes('table_constraints')) {
        return { rows: [{ table_name: 'users', column_name: 'id' }] };
      }
      if (String(sql).includes('FROM pg_constraint con')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    await expect(deleteUser('user-1')).rejects.toThrow('foreign key violation');

    const sqlCalls = mockClient.query.mock.calls.map(([sql]) => String(sql));
    expect(sqlCalls).toContain('ROLLBACK');
    expect(sqlCalls).not.toContain('COMMIT');
    expect(mockClient.release).toHaveBeenCalled();
  });
});
