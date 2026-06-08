import {
  advanceRecurrenceCycleCursor,
  getExistingInstanceMatchSql,
  getRecurrenceCatchupLimit,
  isDailyRecurrenceDue,
  resolveDailyInstanceStartDate,
  resolveInstanceStartDate,
  shouldContinueRecurrenceCatchup,
} from '../recurrenceCycleUtils';
import { calculateNextCycleStartDate } from '../cycleStartRecurrence';

describe('recurrenceCycleUtils', () => {
  it('uses higher catch-up limits for slower frequencies', () => {
    expect(getRecurrenceCatchupLimit('daily')).toBeGreaterThan(getRecurrenceCatchupLimit('monthly'));
    expect(getRecurrenceCatchupLimit('monthly')).toBeGreaterThan(getRecurrenceCatchupLimit('yearly'));
    expect(getRecurrenceCatchupLimit('weekly')).toBe(104);
  });

  it('matches instances by calendar period, not exact timestamp', () => {
    expect(getExistingInstanceMatchSql('daily')).toContain('::date');
    expect(getExistingInstanceMatchSql('weekly')).toContain("date_trunc('week'");
    expect(getExistingInstanceMatchSql('monthly')).toContain("date_trunc('month'");
    expect(getExistingInstanceMatchSql('annually')).toContain("date_trunc('year'");
    expect(getExistingInstanceMatchSql('quarterly')).toContain("date_trunc('quarter'");
  });

  it('advances weekly cycles one week at a time for catch-up simulation', () => {
    const start = new Date(2026, 4, 20, 9, 0, 0, 0);
    const next = advanceRecurrenceCycleCursor('weekly', 1, null, start);
    expect(next.getDate()).toBe(27);
    expect(next.getMonth()).toBe(4);
  });

  it('advances monthly cycles to the next month start preserving time', () => {
    const start = new Date(2026, 4, 12, 9, 0, 0, 0);
    const next = advanceRecurrenceCycleCursor('monthly', 1, null, start);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(5);
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(9);
  });

  it('advances yearly cycles by twelve months when no accounting year anchor', () => {
    const start = new Date(2026, 2, 15, 9, 0, 0, 0);
    const next = advanceRecurrenceCycleCursor('annually', 1, null, start);
    expect(next.getFullYear()).toBe(2027);
    expect(next.getMonth()).toBe(2);
    expect(next.getDate()).toBe(1);
  });

  it('treats daily recurrence as due on logical instance day, not cursor time-of-day', () => {
    const next = new Date('2026-06-05T22:00:00.000Z');
    const morning = new Date('2026-06-06T05:11:00.000Z');
    expect(isDailyRecurrenceDue(next, morning)).toBe(true);
    expect(shouldContinueRecurrenceCatchup(next, morning, 0, 400, 'daily')).toBe(true);
    const futureCursor = new Date('2026-06-06T22:00:00.000Z');
    expect(isDailyRecurrenceDue(futureCursor, morning)).toBe(false);
  });

  it('normalizes monthly and quarterly generated starts to the 1st of the cycle month', () => {
    const midMonth = new Date(2026, 4, 15, 14, 30, 0, 0);
    const monthlyStart = resolveInstanceStartDate('monthly', midMonth);
    expect(monthlyStart.getFullYear()).toBe(2026);
    expect(monthlyStart.getMonth()).toBe(4);
    expect(monthlyStart.getDate()).toBe(1);
    expect(monthlyStart.getHours()).toBe(14);
    expect(monthlyStart.getMinutes()).toBe(30);

    const quarterlyStart = resolveInstanceStartDate('quarterly', new Date(2026, 5, 18, 9, 0, 0, 0));
    expect(quarterlyStart.getMonth()).toBe(5);
    expect(quarterlyStart.getDate()).toBe(1);
  });

  it('keeps weekly and yearly cycle cursors as instance starts', () => {
    const weekly = new Date(2026, 4, 20, 9, 0, 0, 0);
    expect(resolveInstanceStartDate('weekly', weekly).getDate()).toBe(20);

    const yearly = new Date(2027, 3, 1, 9, 0, 0, 0);
    const yearlyStart = resolveInstanceStartDate('annually', yearly);
    expect(yearlyStart.getFullYear()).toBe(2027);
    expect(yearlyStart.getMonth()).toBe(3);
    expect(yearlyStart.getDate()).toBe(1);
  });

  it('maps eve-before daily cursor (22:00 UTC) to naive calendar midnight', () => {
    const cursor = new Date('2026-06-05T22:00:00.000Z');
    const now = new Date('2026-06-06T05:11:00.000Z');
    const timeSource = new Date('2026-05-30T22:00:00.000Z');
    const start = resolveDailyInstanceStartDate(cursor, timeSource, now);
    expect(start.toISOString()).toBe('2026-06-06T00:00:00.000Z');
  });

  it('advances daily catch-up one day per cycle when using eve-before cursors', () => {
    const { applyRecurrenceTimeOfDay } = require('../cycleStartRecurrence');
    const now = new Date('2026-06-06T10:00:00.000Z');
    const timeSource = new Date('2026-05-30T22:00:00.000Z');
    let cursor = new Date('2026-06-04T22:00:00.000Z');
    const createdDays: string[] = [];
    let guard = 0;
    const max = getRecurrenceCatchupLimit('daily');

    while (shouldContinueRecurrenceCatchup(cursor, now, guard, max, 'daily')) {
      const start = resolveDailyInstanceStartDate(cursor, timeSource, now);
      createdDays.push(start.toISOString().slice(0, 10));
      cursor = applyRecurrenceTimeOfDay(
        calculateNextCycleStartDate('daily', 1, null, cursor),
        timeSource
      );
      guard += 1;
    }

    expect(createdDays).toEqual(['2026-06-05', '2026-06-06']);
    expect(cursor.toISOString()).toBe('2026-06-06T22:00:00.000Z');
  });

  it('simulates uninterrupted weekly catch-up across missed job runs', () => {
    const now = new Date(2026, 5, 3, 12, 0, 0, 0);
    let cursor = new Date(2026, 4, 20, 9, 0, 0, 0);
    const created: Date[] = [];
    let guard = 0;
    const max = getRecurrenceCatchupLimit('weekly');

    while (shouldContinueRecurrenceCatchup(cursor, now, guard, max)) {
      created.push(resolveInstanceStartDate('weekly', cursor));
      cursor = calculateNextCycleStartDate('weekly', 1, null, cursor);
      guard += 1;
    }

    expect(created).toHaveLength(3);
    expect(created[0].getDate()).toBe(20);
    expect(created[1].getDate()).toBe(27);
    expect(created[2].getDate()).toBe(3);
    expect(cursor.getMonth()).toBe(5);
    expect(cursor.getDate()).toBe(10);
  });

  it('simulates uninterrupted monthly catch-up across missed job runs', () => {
    const now = new Date(2026, 5, 15, 12, 0, 0, 0);
    let cursor = new Date(2026, 2, 1, 9, 0, 0, 0);
    const created: string[] = [];
    let guard = 0;
    const max = getRecurrenceCatchupLimit('monthly');

    while (shouldContinueRecurrenceCatchup(cursor, now, guard, max)) {
      const start = resolveInstanceStartDate('monthly', cursor);
      created.push(`${start.getFullYear()}-${start.getMonth() + 1}`);
      cursor = calculateNextCycleStartDate('monthly', 1, null, cursor);
      guard += 1;
    }

    expect(created).toEqual(['2026-3', '2026-4', '2026-5', '2026-6']);
    expect(cursor.getMonth()).toBe(6);
    expect(cursor.getDate()).toBe(1);
  });

  it('simulates uninterrupted yearly catch-up across missed job runs', () => {
    const now = new Date(2028, 6, 1, 12, 0, 0, 0);
    let cursor = new Date(2026, 3, 1, 9, 0, 0, 0);
    const createdYears: number[] = [];
    let guard = 0;
    const max = getRecurrenceCatchupLimit('yearly');

    while (shouldContinueRecurrenceCatchup(cursor, now, guard, max)) {
      createdYears.push(resolveInstanceStartDate('annually', cursor).getFullYear());
      cursor = calculateNextCycleStartDate('annually', 1, null, cursor);
      guard += 1;
    }

    expect(createdYears).toEqual([2026, 2027, 2028]);
    expect(cursor.getFullYear()).toBe(2029);
  });
});
