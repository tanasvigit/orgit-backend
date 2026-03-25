import { getMessages } from '../messageService';

// Mock database
jest.mock('../../config/database', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

import { query } from '../../config/database';

const queryMock = query as unknown as jest.Mock;

describe('messageService.getMessages visibility behaviour', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queryMock.mockResolvedValue({ rows: [] });
  });

  it('does not apply org-based visibility filters for direct (one-to-one) messages', async () => {
    await getMessages('user-1', 'user-2', null, 50, null);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql] = queryMock.mock.calls[0];

    expect(sql).not.toContain('group_members');
    expect(sql).not.toContain("m.visibility_mode = 'shared_to_group'");
    expect(sql).not.toContain("m.visibility_mode = 'org_only'");
  });

  it('applies org-based visibility filters for group/Task Group messages', async () => {
    await getMessages('user-1', null, 'group-1', 50, null);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql] = queryMock.mock.calls[0];

    expect(sql).toContain('FROM messages m');
    expect(sql).toContain('INNER JOIN group_members gm');
    expect(sql).toContain("m.visibility_mode = 'shared_to_group'");
    expect(sql).toContain("m.visibility_mode = 'org_only' AND m.sender_organization_id = gm.organization_id");
  });
});

