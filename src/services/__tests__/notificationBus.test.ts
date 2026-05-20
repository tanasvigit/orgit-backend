import { mapTypeToDbType } from '../notification-bus.service';

describe('notification-bus mapTypeToDbType', () => {
  it('maps message and task types for DB constraint', () => {
    expect(mapTypeToDbType('MESSAGE_RECEIVED')).toBe('message_received');
    expect(mapTypeToDbType('TASK_ASSIGNED')).toBe('task_assigned');
    expect(mapTypeToDbType('TASK_STATUS_CHANGED')).toBe('TASK_STATUS_CHANGED');
    expect(mapTypeToDbType('EXIT_REQUEST_RECEIVED')).toBe('EXIT_REQUEST_RECEIVED');
    expect(mapTypeToDbType('MEMBER_ADDED')).toBe('MEMBER_ADDED');
  });
});
