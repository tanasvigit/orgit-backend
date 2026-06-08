export type CycleRecurrenceFrequency =
  | 'daily'
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

export const startOfCalendarDay = (date: Date): Date => {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setHours(0, 0, 0, 0);
  return next;
};

/** UTC calendar day at 00:00:00.000Z — used for daily recurrence (create, job, SQL). */
export const startOfUtcCalendarDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

export const addUtcCalendarDays = (date: Date, days: number): Date => {
  const next = startOfUtcCalendarDay(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

/** Apply anchor task/template time-of-day (UTC) onto a UTC calendar day. */
export const applyRecurrenceTimeOfDay = (calendarDayUtc: Date, timeSource: Date): Date => {
  const out = startOfUtcCalendarDay(calendarDayUtc);
  out.setUTCHours(
    timeSource.getUTCHours(),
    timeSource.getUTCMinutes(),
    timeSource.getUTCSeconds(),
    timeSource.getUTCMilliseconds()
  );
  return out;
};

const parseAccountingYearStart = (
  accountingYearStart: string | null | undefined
): { monthIndex: number; day: number } | null => {
  if (!accountingYearStart) return null;

  const normalized = String(accountingYearStart).trim();
  const fullDateMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const monthDayMatch = normalized.match(/^(\d{2})-(\d{2})$/);

  const month = Number(fullDateMatch?.[2] || monthDayMatch?.[1]);
  const day = Number(fullDateMatch?.[3] || monthDayMatch?.[2]);
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1) {
    return null;
  }

  const monthIndex = month - 1;
  const daysInMonth = new Date(2000, monthIndex + 1, 0).getDate();
  return {
    monthIndex,
    day: Math.min(day, daysInMonth),
  };
};

export const calculateNextFinancialYearStart = (
  currentCycleStart: Date,
  recurrenceInterval: number | null | undefined,
  accountingYearStart: string | null | undefined
): Date => {
  const base = new Date(currentCycleStart);
  const interval = Math.max(1, Number(recurrenceInterval) || 1);
  const anchor = parseAccountingYearStart(accountingYearStart) || { monthIndex: 3, day: 1 };

  const next = new Date(base.getFullYear(), anchor.monthIndex, anchor.day);
  next.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), base.getMilliseconds());

  if (next.getTime() <= base.getTime()) {
    next.setFullYear(next.getFullYear() + 1);
  }
  if (interval > 1) {
    next.setFullYear(next.getFullYear() + interval - 1);
  }

  return next;
};

export const normalizeCycleRecurrenceFrequency = (
  recurrenceType: string | null | undefined,
  specificWeekday: number | null | undefined
): CycleRecurrenceFrequency => {
  const normalized = String(recurrenceType || '').toLowerCase().trim();
  if (normalized === 'daily') return 'daily';
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
  currentCycleStart: Date,
  accountingYearStart?: string | null
): Date => {
  const frequency = normalizeCycleRecurrenceFrequency(recurrenceType, specificWeekday);
  const interval = Math.max(1, Number(recurrenceInterval) || 1);
  const base = new Date(currentCycleStart);

  switch (frequency) {
    case 'daily':
      return addUtcCalendarDays(base, interval);
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
      if (accountingYearStart) {
        return calculateNextFinancialYearStart(base, interval, accountingYearStart);
      }
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
