import { generateNextRecurrence } from '../recurringTaskService';
import { query } from '../../config/database';
import { createTaskGroup } from '../groupService';
import { logTaskActivity } from '../taskActivityLogger';

jest.mock('../../config/database', () => ({
  query: jest.fn(),
}));

jest.mock('../groupService', () => ({
  createTaskGroup: jest.fn(),
}));

jest.mock('../taskActivityLogger', () => ({
  logTaskActivity: jest.fn(),
}));

describe('generateNextRecurrence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a new recurring instance and advances template cursor', async () => {
    const mockedQuery = query as jest.Mock;
    mockedQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'template-1',
            title: 'Sample',
            description: 'desc',
            organization_id: 'org-1',
            creator_id: 'creator-1',
            recurrence_type: 'monthly',
            recurrence_interval: 1,
            specific_weekday: null,
            base_due_offset: '5 days',
            next_recurrence_date: '2026-05-20T00:00:00.000Z',
            reporting_member_id: null,
            category: 'general',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ user_id: 'creator-1', role: 'creator' }, { user_id: 'member-1', role: 'member' }],
      })
      .mockResolvedValueOnce({ rows: [{ max_no: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'instance-2' }] })
      .mockResolvedValue({ rows: [] });

    await generateNextRecurrence();

    expect(mockedQuery).toHaveBeenCalled();
    const insertTaskCall = mockedQuery.mock.calls.find((c) =>
      String(c[0]).includes("INSERT INTO tasks") && String(c[0]).includes("'recurring_instance'")
    );
    expect(insertTaskCall).toBeDefined();

    expect(createTaskGroup).toHaveBeenCalled();
    expect(logTaskActivity).toHaveBeenCalled();

    const updateTemplateCall = mockedQuery.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE task_recurrence_templates')
    );
    expect(updateTemplateCall).toBeDefined();
  });

  it('returns safely when template table migration is not applied', async () => {
    const mockedQuery = query as jest.Mock;
    mockedQuery.mockRejectedValueOnce(new Error('relation "task_recurrence_templates" does not exist'));

    await expect(generateNextRecurrence()).resolves.toBeUndefined();
    expect(createTaskGroup).not.toHaveBeenCalled();
  });
});

