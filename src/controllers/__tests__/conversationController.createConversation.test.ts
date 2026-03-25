import type { Response } from 'express';
import { createConversation } from '../conversationController';

// Mock database helpers used by conversationController
jest.mock('../../config/database', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
}));

import { query } from '../../config/database';

const queryMock = query as unknown as jest.Mock;

function createMockResponse() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response & {
    status: jest.Mock;
    json: jest.Mock;
  };
}

describe('conversationController.createConversation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects self-conversation with a 400 error', async () => {
    const req: any = {
      user: { userId: 'user-1' },
      body: { otherUserId: 'user-1' },
      app: { get: jest.fn().mockReturnValue(undefined) },
    };
    const res = createMockResponse();

    await createConversation(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Cannot create conversation with yourself' });
  });

  it('returns 404 when target user does not exist', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }); // SELECT id, status FROM users ...

    const req: any = {
      user: { userId: 'user-1' },
      body: { otherUserId: 'other-user' },
      app: { get: jest.fn().mockReturnValue(undefined) },
    };
    const res = createMockResponse();

    await createConversation(req, res);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain('FROM users');

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'User not found' });
  });

  it('returns 400 when target user is inactive', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'other-user', status: 'inactive' }],
    });

    const req: any = {
      user: { userId: 'user-1' },
      body: { otherUserId: 'other-user' },
      app: { get: jest.fn().mockReturnValue(undefined) },
    };
    const res = createMockResponse();

    await createConversation(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Cannot start a conversation with an inactive user',
    });
  });
});

