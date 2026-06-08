import {
  resolveBulkRecurrenceSchedule,
  buildIntervalLiteralFromDates,
} from '../recurringTemplateSetup';
import { calculateNextCycleStartDate } from '../cycleStartRecurrence';

describe('recurringTemplateSetup', () => {
  it('buildIntervalLiteralFromDates returns seconds between start and due', () => {
    const start = new Date(2026, 5, 1, 0, 0, 0, 0);
    const due = new Date(2026, 5, 4, 0, 0, 0, 0);
    expect(buildIntervalLiteralFromDates(start, due)).toBe('259200 seconds');
  });

  it('resolveBulkRecurrenceSchedule supports daily recurrence with UTC cursor', () => {
    const dueDate = new Date('2026-06-03T22:00:00.000Z');
    const schedule = resolveBulkRecurrenceSchedule('daily', { startDate: null, dueDate });
    expect(schedule?.frequency).toBe('daily');
    expect(schedule?.recurrenceType).toBe('daily');
    expect(schedule?.nextRecurrenceDate.toISOString()).toBe('2026-06-04T22:00:00.000Z');
  });

  it('resolveBulkRecurrenceSchedule uses accounting year for yearly recurrence', () => {
    const startDate = new Date(2026, 5, 15, 9, 0, 0, 0);
    const dueDate = new Date(2026, 5, 20, 9, 0, 0, 0);
    const schedule = resolveBulkRecurrenceSchedule('yearly', {
      startDate,
      dueDate,
      accountingYearStart: '2026-04-01',
    });
    expect(schedule?.recurrenceType).toBe('annually');
    expect(schedule?.nextRecurrenceDate.getFullYear()).toBe(2027);
    expect(schedule?.nextRecurrenceDate.getMonth()).toBe(3);
  });

  it('resolveBulkRecurrenceSchedule matches web weekly mapping', () => {
    const dueDate = new Date(2026, 5, 4, 9, 0, 0, 0);
    const schedule = resolveBulkRecurrenceSchedule('weekly', { startDate: null, dueDate });
    expect(schedule?.frequency).toBe('specific_weekday');
    expect(schedule?.specificWeekday).toBe(dueDate.getDay());
    const expectedNext = calculateNextCycleStartDate('weekly', 1, schedule?.specificWeekday ?? null, dueDate);
    expect(schedule?.nextRecurrenceDate.getTime()).toBe(expectedNext.getTime());
  });
});
