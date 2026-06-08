import { generateNextRecurrence, extractBaseTitle, formatRecurringTitle } from '../recurringTaskService';
import { query } from '../../config/database';
import { logTaskActivity } from '../taskActivityLogger';
import { dispatchNotification } from '../notification-bus.service';

jest.mock('../../config/database', () => ({
  query: jest.fn(),
}));

jest.mock('../taskActivityLogger', () => ({
  logTaskActivity: jest.fn(),
}));

jest.mock('../notification-bus.service', () => ({
  dispatchNotification: jest.fn().mockResolvedValue({ sent: 1 }),
}));

function mockCatchupRecurrenceQuery(options: {
  template: Record<string, unknown>;
  matchExisting?: (sql: string) => boolean;
}) {
  let insertCount = 0;
  let templateNextDate: Date | null = null;
  const insertedTasks: Array<{ start_date: Date; target_date: Date | null; due_date: Date }> = [];

  const taskColumns = [
    { column_name: 'title' },
    { column_name: 'frequency' },
    { column_name: 'description' },
    { column_name: 'task_type' },
    { column_name: 'creator_id' },
    { column_name: 'created_by' },
    { column_name: 'organization_id' },
    { column_name: 'start_date' },
    { column_name: 'target_date' },
    { column_name: 'due_date' },
    { column_name: 'specific_weekday' },
    { column_name: 'recurrence_type' },
    { column_name: 'recurrence_interval' },
    { column_name: 'category' },
    { column_name: 'status' },
    { column_name: 'recurrence_template_id' },
    { column_name: 'parent_task_id' },
    { column_name: 'recurrence_instance_no' },
    { column_name: 'reporting_member_id' },
  ];

  const mockedQuery = query as jest.Mock;
  mockedQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    const q = String(sql);
    if (q.includes('to_regclass')) return { rows: [{ table_name: 'task_recurrence_templates' }] };
    if (q.includes('information_schema.columns')) {
      const tableName = String(params?.[0] ?? '');
      if (tableName === 'tasks') return { rows: taskColumns };
      return { rows: [] };
    }
    if (q.includes('generate_series')) {
      return { rows: [] };
    }
    if (q.includes('FROM task_recurrence_templates') && q.includes('status =')) {
      return { rows: [options.template] };
    }
    if (q.includes('FROM tasks') && q.includes('recurrence_template_id = $1')) {
      return { rows: [] };
    }
    if (q.includes('SELECT * FROM tasks WHERE id =')) return { rows: [] };
    if (q.includes('task_template_assignees')) {
      return { rows: [{ user_id: 'creator-1', role: 'creator' }] };
    }
    if (q.includes('COUNT(*)::int AS cnt')) return { rows: [{ cnt: insertCount }] };
    if (options.matchExisting?.(q) || q.includes('start_date::date') || q.includes('date_trunc(')) {
      return { rows: [] };
    }
    if (q.includes('MAX(recurrence_instance_no)')) return { rows: [{ max_no: insertCount }] };
    if (q.includes('INSERT INTO tasks')) {
      insertCount += 1;
      const cols = q.match(/INSERT INTO tasks \(([^)]+)\)/)?.[1]?.split(',').map((c) => c.trim()) ?? [];
      const values = (params ?? []) as unknown[];
      const row: Record<string, unknown> = {};
      cols.forEach((col, idx) => {
        row[col] = values[idx];
      });
      insertedTasks.push({
        start_date: row.start_date as Date,
        target_date: (row.target_date as Date | null) ?? null,
        due_date: row.due_date as Date,
      });
      return { rows: [{ id: `instance-${insertCount}`, title: String(options.template.title || 'task') }] };
    }
    if (q.includes('INSERT INTO task_assignees')) return { rows: [] };
    if (q.includes('conversations') && q.includes('column_name')) return { rows: [] };
    if (q.includes('INSERT INTO conversations')) return { rows: [{ id: `conv-${insertCount}` }] };
    if (q.includes('INSERT INTO conversation_members')) return { rows: [] };
    if (q.includes('SELECT name FROM users')) return { rows: [{ name: 'Creator' }] };
    if (q.includes('INSERT INTO messages')) return { rows: [{ id: 'msg-1' }] };
    if (q.includes('UPDATE task_recurrence_templates')) {
      templateNextDate = params?.[0] as Date;
      return { rows: [] };
    }
    return { rows: [] };
  });

  return {
    getInsertCount: () => insertCount,
    getTemplateNextDate: () => templateNextDate,
    getInsertedTasks: () => insertedTasks,
  };
}

describe('recurring title helpers', () => {
  it('formatRecurringTitle returns stable base title without cycle suffix', () => {
    const daily = formatRecurringTitle('Report', new Date('2026-05-30T00:00:00.000Z'), 'daily');
    expect(daily).toBe('Report');
    const monthly = formatRecurringTitle('Report', new Date('2026-05-30T00:00:00.000Z'), 'monthly');
    expect(monthly).toBe('Report');
    const stripped = formatRecurringTitle('Report 30 may', new Date('2026-06-01T00:00:00.000Z'), 'daily');
    expect(stripped).toBe('Report');
  });

  it('extractBaseTitle strips daily and monthly suffixes', () => {
    expect(extractBaseTitle('Report 30 may')).toBe('Report');
    expect(extractBaseTitle('Report may')).toBe('Report');
    expect(extractBaseTitle('Report - May')).toBe('Report');
  });
});

describe('generateNextRecurrence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stores daily frequency, auto-accepts assignees, and notifies users', async () => {
    const mockedQuery = query as jest.Mock;
    mockedQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      const q = String(sql);
      if (q.includes('to_regclass')) return { rows: [{ table_name: 'task_recurrence_templates' }] };
      if (q.includes('information_schema.columns')) {
        const tableName = String(params?.[0] ?? '');
        if (tableName === 'task_recurrence_templates') {
          return {
            rows: [
              { column_name: 'client_name' },
              { column_name: 'org_structure_path' },
              { column_name: 'org_structure_node_id' },
            ],
          };
        }
        if (tableName === 'tasks') {
          return {
            rows: [
              { column_name: 'title' },
              { column_name: 'compliance_id' },
              { column_name: 'document_id' },
              { column_name: 'auto_escalate' },
              { column_name: 'client_name' },
              { column_name: 'org_structure_path' },
              { column_name: 'org_structure_node_id' },
              { column_name: 'frequency' },
              { column_name: 'recurrence_template_id' },
              { column_name: 'recurrence_instance_no' },
              { column_name: 'task_type' },
              { column_name: 'description' },
              { column_name: 'creator_id' },
              { column_name: 'created_by' },
              { column_name: 'organization_id' },
              { column_name: 'start_date' },
              { column_name: 'target_date' },
              { column_name: 'due_date' },
              { column_name: 'specific_weekday' },
              { column_name: 'recurrence_type' },
              { column_name: 'recurrence_interval' },
              { column_name: 'category' },
              { column_name: 'status' },
              { column_name: 'parent_task_id' },
              { column_name: 'reporting_member_id' },
            ],
          };
        }
        return { rows: [] };
      }
      if (q.includes('FROM task_recurrence_templates') && q.includes('status =')) {
        return {
          rows: [
            {
              id: 'template-daily',
              task_id: 'source-task-1',
              title: 'Daily Report',
              description: 'desc',
              organization_id: 'org-1',
              creator_id: 'creator-1',
              recurrence_type: 'daily',
              recurrence_interval: 1,
              specific_weekday: null,
              base_target_offset: null,
              base_due_offset: '1 day',
              next_recurrence_date: new Date(2026, 5, 3, 0, 0, 0, 0),
              reporting_member_id: null,
              category: 'general',
            },
          ],
        };
      }
      if (q.includes('SELECT * FROM tasks WHERE id =')) {
        return {
          rows: [
            {
              id: 'source-task-1',
              compliance_id: 'comp-1',
              document_id: 'doc-1',
              auto_escalate: true,
              client_name: 'Acme Client',
              org_structure_path: [{ name: 'Region', levelLabel: 'Region' }, { name: 'Branch 1' }],
              org_structure_node_id: 'node-1',
            },
          ],
        };
      }
      if (q.includes('task_template_assignees')) {
        return { rows: [{ user_id: 'creator-1', role: 'creator' }, { user_id: 'member-1', role: 'member' }] };
      }
      if (q.includes('role = \'escalation_contact\'')) return { rows: [] };
      if (q.includes('COUNT(*)::int AS cnt')) return { rows: [{ cnt: 0 }] };
      if (q.includes('existingInstanceResult') || (q.includes('FROM tasks') && q.includes('start_date::date'))) {
        return { rows: [] };
      }
      if (q.includes('MAX(recurrence_instance_no)')) return { rows: [{ max_no: 0 }] };
      if (q.includes('INSERT INTO tasks')) {
        return { rows: [{ id: 'instance-1', title: 'Daily Report 30 may' }] };
      }
      if (q.includes('INSERT INTO task_assignees')) return { rows: [] };
      if (q.includes('conversations') && q.includes('column_name')) return { rows: [{ column_name: 'type' }] };
      if (q.includes('INSERT INTO conversations')) return { rows: [{ id: 'conv-1' }] };
      if (q.includes('INSERT INTO conversation_members')) return { rows: [] };
      if (q.includes('SELECT name FROM users')) return { rows: [{ name: 'Owner User' }] };
      if (q.includes('messages') && q.includes('column_name')) return { rows: [] };
      if (q.includes('INSERT INTO messages')) return { rows: [{ id: 'msg-1' }] };
      if (q.includes('INSERT INTO message_status')) return { rows: [] };
      if (q.includes('UPDATE task_recurrence_templates')) return { rows: [] };
      return { rows: [] };
    });

    const io = { to: jest.fn().mockReturnValue({ emit: jest.fn() }) };
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 5, 3, 12, 0, 0, 0));
    await generateNextRecurrence(io);
    jest.useRealTimers();

    const insertTaskCall = mockedQuery.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO tasks') && String(c[0]).includes('recurrence_template_id')
    );
    expect(insertTaskCall).toBeDefined();
    expect(String(insertTaskCall?.[0])).toContain('compliance_id');
    expect(String(insertTaskCall?.[0])).toContain('document_id');
    expect(String(insertTaskCall?.[0])).toContain('client_name');
    expect(String(insertTaskCall?.[0])).toContain('org_structure_path');

    const assigneeInsert = mockedQuery.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO task_assignees')
    );
    expect(String(assigneeInsert?.[0])).toContain('accepted_at');

    expect(dispatchNotification).toHaveBeenCalled();
    expect(logTaskActivity).toHaveBeenCalled();
    expect(io.to).toHaveBeenCalled();
  });

  it('creates a new recurring instance and advances template cursor', async () => {
    const mockedQuery = query as jest.Mock;
    mockedQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      const q = String(sql);
      if (q.includes('to_regclass')) return { rows: [{ table_name: 'task_recurrence_templates' }] };
      if (q.includes('information_schema.columns')) {
        const tableName = String(params?.[0] ?? '');
        if (tableName === 'tasks') {
          return {
            rows: [
              { column_name: 'title' },
              { column_name: 'frequency' },
              { column_name: 'recurrence_template_id' },
              { column_name: 'task_type' },
              { column_name: 'description' },
              { column_name: 'creator_id' },
              { column_name: 'organization_id' },
              { column_name: 'start_date' },
              { column_name: 'due_date' },
              { column_name: 'status' },
            ],
          };
        }
        return { rows: [] };
      }
      if (q.includes('FROM task_recurrence_templates') && q.includes('status =')) {
        return {
          rows: [
            {
              id: 'template-1',
              task_id: null,
              title: 'Sample',
              description: 'desc',
              organization_id: 'org-1',
              creator_id: 'creator-1',
              recurrence_type: 'monthly',
              recurrence_interval: 1,
              specific_weekday: null,
              base_target_offset: null,
              base_due_offset: '5 days',
              next_recurrence_date: '2026-05-20T00:00:00.000Z',
              reporting_member_id: null,
              category: 'general',
            },
          ],
        };
      }
      if (q.includes('SELECT * FROM tasks WHERE id =')) return { rows: [] };
      if (q.includes('task_template_assignees')) {
        return {
          rows: [{ user_id: 'creator-1', role: 'creator' }, { user_id: 'member-1', role: 'member' }],
        };
      }
      if (q.includes('date_trunc(')) return { rows: [] };
      if (q.includes('COUNT(*)::int AS cnt')) return { rows: [{ cnt: 0 }] };
      if (q.includes('MAX(recurrence_instance_no)')) return { rows: [{ max_no: 1 }] };
      if (q.includes('INSERT INTO tasks')) return { rows: [{ id: 'instance-2', title: 'Sample may' }] };
      if (q.includes('INSERT INTO conversations')) return { rows: [{ id: 'conv-2' }] };
      if (q.includes('SELECT name FROM users')) return { rows: [{ name: 'Owner User' }] };
      if (q.includes('INSERT INTO messages')) return { rows: [{ id: 'msg-2' }] };
      if (q.includes('UPDATE task_recurrence_templates')) return { rows: [] };
      return { rows: [] };
    });

    await generateNextRecurrence();

    const updateTemplateCall = mockedQuery.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE task_recurrence_templates')
    );
    expect(updateTemplateCall).toBeDefined();
    expect(logTaskActivity).toHaveBeenCalled();
  });

  it('returns safely when template table migration is not applied', async () => {
    const mockedQuery = query as jest.Mock;
    mockedQuery.mockResolvedValueOnce({ rows: [{ table_name: null }] });

    await expect(generateNextRecurrence()).resolves.toBeUndefined();
    expect(logTaskActivity).not.toHaveBeenCalled();
  });
});

describe('generateNextRecurrence catch-up', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates missed daily instances for eve-before cursors without skipping days', async () => {
    const cursorStart = new Date('2026-06-04T22:00:00.000Z');
    const now = new Date('2026-06-06T10:00:00.000Z');
    const tracker = mockCatchupRecurrenceQuery({
      template: {
        id: 'template-daily-eve',
        task_id: null,
        title: 'daily',
        description: null,
        organization_id: 'org-1',
        creator_id: 'creator-1',
        recurrence_type: 'daily',
        recurrence_interval: 1,
        specific_weekday: null,
        base_start_date: '2026-05-30T22:00:00.000Z',
        base_target_offset: '6 days',
        base_due_offset: '9 days',
        next_recurrence_date: cursorStart,
        reporting_member_id: null,
        category: 'general',
      },
    });

    jest.useFakeTimers();
    jest.setSystemTime(now);
    await generateNextRecurrence();
    jest.useRealTimers();

    expect(tracker.getInsertCount()).toBe(2);
    expect(tracker.getTemplateNextDate()?.toISOString()).toBe('2026-06-06T22:00:00.000Z');
  });

  it('creates every missed daily instance when template cursor is behind', async () => {
    const cursorStart = new Date('2026-06-02T00:00:00.000Z');
    const now = new Date('2026-06-03T23:00:00.000Z');
    const tracker = mockCatchupRecurrenceQuery({
      template: {
        id: 'template-daily-catchup',
        task_id: null,
        title: 'daily',
        description: null,
        organization_id: 'org-1',
        creator_id: 'creator-1',
        recurrence_type: 'daily',
        recurrence_interval: 1,
        specific_weekday: null,
        base_start_date: '2026-06-01T12:00:00.000Z',
        base_target_offset: '6 days',
        base_due_offset: '9 days',
        next_recurrence_date: cursorStart,
        reporting_member_id: null,
        category: 'general',
      },
    });

    jest.useFakeTimers();
    jest.setSystemTime(now);
    await generateNextRecurrence();
    jest.useRealTimers();

    expect(tracker.getInsertCount()).toBe(2);
    const expectedNext = new Date('2026-06-04T12:00:00.000Z');
    expect(tracker.getTemplateNextDate()?.toISOString()).toBe(expectedNext.toISOString());
  });

  it('creates every missed weekly instance when template cursor is behind', async () => {
    const cursorStart = new Date(2026, 4, 20, 9, 0, 0, 0);
    const now = new Date(2026, 5, 3, 12, 0, 0, 0);
    const tracker = mockCatchupRecurrenceQuery({
      template: {
        id: 'template-weekly-catchup',
        task_id: null,
        title: 'weekly report',
        description: null,
        organization_id: 'org-1',
        creator_id: 'creator-1',
        recurrence_type: 'weekly',
        recurrence_interval: 1,
        specific_weekday: 2,
        base_target_offset: null,
        base_due_offset: '3 days',
        next_recurrence_date: cursorStart,
        reporting_member_id: null,
        category: 'general',
      },
    });

    jest.useFakeTimers();
    jest.setSystemTime(now);
    await generateNextRecurrence();
    jest.useRealTimers();

    expect(tracker.getInsertCount()).toBe(3);
    const expectedNext = new Date(2026, 5, 10, 9, 0, 0, 0);
    expect(tracker.getTemplateNextDate()?.getTime()).toBe(expectedNext.getTime());
  });

  it('starts monthly recurrences on the 1st and preserves target/due offsets from the template', async () => {
    const cursorStart = new Date(2026, 4, 15, 9, 0, 0, 0);
    const now = new Date(2026, 4, 20, 12, 0, 0, 0);
    const tracker = mockCatchupRecurrenceQuery({
      template: {
        id: 'template-monthly-mid-month',
        task_id: null,
        title: 'monthly compliance',
        description: null,
        organization_id: 'org-1',
        creator_id: 'creator-1',
        recurrence_type: 'monthly',
        recurrence_interval: 1,
        specific_weekday: null,
        base_target_offset: '3 days',
        base_due_offset: '7 days',
        next_recurrence_date: cursorStart,
        reporting_member_id: null,
        category: 'general',
      },
    });

    jest.useFakeTimers();
    jest.setSystemTime(now);
    await generateNextRecurrence();
    jest.useRealTimers();

    expect(tracker.getInsertCount()).toBe(1);
    const [created] = tracker.getInsertedTasks();
    expect(created.start_date.getDate()).toBe(1);
    expect(created.start_date.getMonth()).toBe(4);
    expect(created.target_date?.getDate()).toBe(4);
    expect(created.due_date.getDate()).toBe(8);
  });

  it('creates every missed monthly instance when template cursor is behind', async () => {
    const cursorStart = new Date(2026, 2, 1, 9, 0, 0, 0);
    const now = new Date(2026, 5, 15, 12, 0, 0, 0);
    const tracker = mockCatchupRecurrenceQuery({
      template: {
        id: 'template-monthly-catchup',
        task_id: null,
        title: 'monthly close',
        description: null,
        organization_id: 'org-1',
        creator_id: 'creator-1',
        recurrence_type: 'monthly',
        recurrence_interval: 1,
        specific_weekday: null,
        base_target_offset: '3 days',
        base_due_offset: '7 days',
        next_recurrence_date: cursorStart,
        reporting_member_id: null,
        category: 'general',
      },
    });

    jest.useFakeTimers();
    jest.setSystemTime(now);
    await generateNextRecurrence();
    jest.useRealTimers();

    expect(tracker.getInsertCount()).toBe(4);
    const expectedNext = new Date(2026, 6, 1, 9, 0, 0, 0);
    expect(tracker.getTemplateNextDate()?.getTime()).toBe(expectedNext.getTime());
  });

  it('creates every missed yearly instance when template cursor is behind', async () => {
    const cursorStart = new Date(2026, 3, 1, 9, 0, 0, 0);
    const now = new Date(2028, 5, 1, 12, 0, 0, 0);
    const tracker = mockCatchupRecurrenceQuery({
      template: {
        id: 'template-yearly-catchup',
        task_id: null,
        title: 'annual audit',
        description: null,
        organization_id: 'org-1',
        creator_id: 'creator-1',
        recurrence_type: 'annually',
        recurrence_interval: 1,
        specific_weekday: null,
        base_target_offset: null,
        base_due_offset: '30 days',
        next_recurrence_date: cursorStart,
        reporting_member_id: null,
        category: 'general',
      },
    });

    jest.useFakeTimers();
    jest.setSystemTime(now);
    await generateNextRecurrence();
    jest.useRealTimers();

    expect(tracker.getInsertCount()).toBe(3);
    const expectedNext = new Date(2029, 3, 1, 9, 0, 0, 0);
    expect(tracker.getTemplateNextDate()?.getTime()).toBe(expectedNext.getTime());
  });
});
