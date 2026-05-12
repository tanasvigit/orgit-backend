import {
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
});
