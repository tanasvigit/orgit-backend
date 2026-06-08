import {
  calculateNextFinancialYearStart,
  calculateNextCycleStartDate,
  startOfCalendarMonth,
} from '../cycleStartRecurrence';

describe('cycleStartRecurrence', () => {
  it('moves monthly cycles to the first day of the next month while preserving offsets from cycle start', () => {
    const currentCycleStart = new Date(2026, 4, 12, 9, 0, 0, 0);
    const nextCycleStart = calculateNextCycleStartDate('monthly', 1, null, currentCycleStart);

    expect(nextCycleStart.getFullYear()).toBe(2026);
    expect(nextCycleStart.getMonth()).toBe(5);
    expect(nextCycleStart.getDate()).toBe(1);

    const targetOffsetDays = 3;
    const dueOffsetDays = 6;
    const targetDate = new Date(nextCycleStart);
    targetDate.setDate(targetDate.getDate() + targetOffsetDays);
    const dueDate = new Date(nextCycleStart);
    dueDate.setDate(dueDate.getDate() + dueOffsetDays);

    expect(targetDate.getDate()).toBe(4);
    expect(dueDate.getDate()).toBe(7);
  });

  it('starts the next monthly cycle on the first day of the following month', () => {
    const currentCycleStart = new Date(2024, 0, 15, 12, 0, 0, 0);
    const nextCycleStart = calculateNextCycleStartDate('monthly', 1, null, currentCycleStart);

    expect(nextCycleStart.toDateString()).toBe(startOfCalendarMonth(new Date(2024, 1, 15)).toDateString());
  });

  it('advances weekly cycles by seven days', () => {
    const currentCycleStart = new Date(2024, 0, 1, 9, 0, 0, 0);
    const nextCycleStart = calculateNextCycleStartDate('weekly', 1, null, currentCycleStart);

    expect(nextCycleStart.toDateString()).toBe(new Date(2024, 0, 8).toDateString());
  });

  it('advances daily cycles by one UTC calendar day', () => {
    const currentCycleStart = new Date('2026-05-31T22:00:00.000Z');
    const nextCycleStart = calculateNextCycleStartDate('daily', 1, null, currentCycleStart);

    expect(nextCycleStart.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('does not treat daily as weekly (+7 days)', () => {
    const cursor = new Date('2026-05-31T22:00:00.000Z');
    const daily = calculateNextCycleStartDate('daily', 1, null, cursor);
    const weekly = calculateNextCycleStartDate('weekly', 1, null, cursor);
    expect(daily.toISOString()).not.toBe(weekly.toISOString());
    expect(weekly.toISOString()).toBe('2026-06-07T22:00:00.000Z');
  });

  it('moves yearly cycles to the next accounting year start', () => {
    const currentCycleStart = new Date(2026, 4, 13, 3, 30, 0, 0);
    const nextCycleStart = calculateNextFinancialYearStart(
      currentCycleStart,
      1,
      '2026-04-01'
    );

    expect(nextCycleStart.getFullYear()).toBe(2027);
    expect(nextCycleStart.getMonth()).toBe(3);
    expect(nextCycleStart.getDate()).toBe(1);
    expect(nextCycleStart.getHours()).toBe(3);
    expect(nextCycleStart.getMinutes()).toBe(30);
  });
});
