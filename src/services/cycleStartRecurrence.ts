export type CycleRecurrenceFrequency =
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | 'specific_weekday';

export const addMonthsClamped = (date: Date, monthsToAdd: number): Date => {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();

  const target = new Date(year, month + monthsToAdd, 1);
  const daysInTargetMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const clampedDay = Math.min(day, daysInTargetMonth);

  const next = new Date(target.getFullYear(), target.getMonth(), clampedDay);
  next.setHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  return next;
};

export const startOfCalendarMonth = (date: Date): Date => {
  const next = new Date(date.getFullYear(), date.getMonth(), 1);
  next.setHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  return next;
};

export const normalizeCycleRecurrenceFrequency = (
  recurrenceType: string | null | undefined,
  specificWeekday: number | null | undefined
): CycleRecurrenceFrequency => {
  const normalized = String(recurrenceType || '').toLowerCase().trim();
  if (normalized === 'daily') return 'weekly';
  if (normalized === 'weekly') {
    return specificWeekday === null || specificWeekday === undefined ? 'weekly' : 'specific_weekday';
  }
  if (normalized === 'monthly') return 'monthly';
  if (normalized === 'quarterly') return 'quarterly';
  if (normalized === 'annually' || normalized === 'yearly') return 'yearly';
  return 'monthly';
};

export const calculateNextCycleStartDate = (
  recurrenceType: string | null | undefined,
  recurrenceInterval: number | null | undefined,
  specificWeekday: number | null | undefined,
  currentCycleStart: Date
): Date => {
  const frequency = normalizeCycleRecurrenceFrequency(recurrenceType, specificWeekday);
  const interval = Math.max(1, Number(recurrenceInterval) || 1);
  const base = new Date(currentCycleStart);

  switch (frequency) {
    case 'weekly':
    case 'specific_weekday': {
      const next = new Date(base);
      next.setDate(next.getDate() + 7 * interval);
      return next;
    }
    case 'monthly':
      return startOfCalendarMonth(addMonthsClamped(base, interval));
    case 'quarterly':
      return startOfCalendarMonth(addMonthsClamped(base, 3 * interval));
    case 'yearly':
      return startOfCalendarMonth(addMonthsClamped(base, 12 * interval));
    default:
      return startOfCalendarMonth(addMonthsClamped(base, interval));
  }
};

export const advanceCycleStartToFuture = (
  recurrenceType: string | null | undefined,
  recurrenceInterval: number | null | undefined,
  specificWeekday: number | null | undefined,
  cycleStart: Date,
  now: Date
): Date => {
  let cursor = new Date(cycleStart);
  let next = calculateNextCycleStartDate(recurrenceType, recurrenceInterval, specificWeekday, cursor);
  let guard = 0;

  while (next.getTime() <= now.getTime() && guard < 500) {
    if (next.getTime() <= cursor.getTime()) {
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    } else {
      cursor = next;
    }
    next = calculateNextCycleStartDate(recurrenceType, recurrenceInterval, specificWeekday, cursor);
    guard += 1;
  }

  return next;
};
