import { searchUsersForChat } from '../userService';

// Mock database query helper
jest.mock('../../config/database', () => ({
  query: jest.fn(),
}));

import { query } from '../../config/database';

describe('userService.searchUsersForChat', () => {
  const queryMock = query as unknown as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns empty array for empty or whitespace-only search', async () => {
    const result1 = await searchUsersForChat('', 20, true, 'user-1');
    const result2 = await searchUsersForChat('   ', 20, true, 'user-1');

    expect(result1).toEqual([]);
    expect(result2).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('includes super_admin filter when excludeSuperAdmin is true', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await searchUsersForChat('john', 10, true, 'user-1');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain("role != 'super_admin'");
  });

  it('does not include super_admin filter when excludeSuperAdmin is false', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await searchUsersForChat('john', 10, false, 'user-1');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql] = queryMock.mock.calls[0];
    expect(sql).not.toContain("role != 'super_admin'");
  });

  it('excludes the requesting user via excludeUserId condition', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const currentUserId = 'current-user-id';
    await searchUsersForChat('john', 10, true, currentUserId);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];

    // Ensure an id != $N predicate is present
    expect(sql).toMatch(/id != \$\d+/);
    expect(params).toContain(currentUserId);
  });
});

