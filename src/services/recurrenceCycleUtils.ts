import {
  addUtcCalendarDays,
  applyRecurrenceTimeOfDay,
  calculateNextCycleStartDate,
  normalizeCycleRecurrenceFrequency,
  startOfCalendarMonth,
  startOfUtcCalendarDay,
} from './cycleStartRecurrence';

/** Max cycles to materialize in one job run (prevents runaway catch-up). */
export function getRecurrenceCatchupLimit(recurrenceType: string | null | undefined): number {
  const freq = normalizeCycleRecurrenceFrequency(recurrenceType, null);
  switch (freq) {
    case 'daily':
      return 400;
    case 'weekly':
    case 'specific_weekday':
      return 104;
    case 'monthly':
      return 36;
    case 'quarterly':
      return 20;
    case 'yearly':
      return 10;
    default:
      return 120;
  }
}

/**
 * Monthly/quarterly generated instances always begin on the 1st of the cycle month,
 * preserving the time-of-day from the template cursor (not the anchor start day-of-month).
 */
export function resolvePeriodInstanceStartDate(
  recurrenceType: string | null | undefined,
  cycleCursor: Date
): Date {
  const freq = normalizeCycleRecurrenceFrequency(recurrenceType, null);
  if (freq === 'monthly' || freq === 'quarterly') {
    return startOfCalendarMonth(cycleCursor);
  }
  return new Date(cycleCursor);
}

/** Normalize cycle start stored on generated task instances. */
export function resolveInstanceStartDate(
  recurrenceType: string | null | undefined,
  cycleCursor: Date,
  timeSource?: Date | null,
  now?: Date
): Date {
  const freq = normalizeCycleRecurrenceFrequency(recurrenceType, null);
  if (freq === 'daily') {
    return resolveDailyInstanceStartDate(cycleCursor, timeSource, now ?? new Date());
  }
  if (freq === 'monthly' || freq === 'quarterly') {
    return resolvePeriodInstanceStartDate(recurrenceType, cycleCursor);
  }
  // Weekly/specific_weekday/yearly: use the scheduled cycle cursor; target/due = start + template offsets.
  return new Date(cycleCursor);
}

/**
 * SQL predicate (without WHERE) to detect an existing instance for the same recurrence period.
 * Uses PostgreSQL date_trunc so weekly/monthly/yearly catch-up does not miss due to time-of-day drift.
 */
export function getExistingInstanceMatchSql(recurrenceType: string | null | undefined): string {
  const freq = normalizeCycleRecurrenceFrequency(recurrenceType, null);
  switch (freq) {
    case 'daily':
      return `${getDailyLogicalInstanceDaySql('start_date')} = ($2::timestamptz AT TIME ZONE 'UTC')::date`;
    case 'weekly':
    case 'specific_weekday':
      return "date_trunc('week', start_date) = date_trunc('week', $2::timestamptz)";
    case 'monthly':
      return "date_trunc('month', start_date) = date_trunc('month', $2::timestamptz)";
    case 'quarterly':
      return "date_trunc('quarter', start_date) = date_trunc('quarter', $2::timestamptz)";
    case 'yearly':
      return "date_trunc('year', start_date) = date_trunc('year', $2::timestamptz)";
    default:
      return "date_trunc('month', start_date) = date_trunc('month', $2::timestamptz)";
  }
}

export function advanceRecurrenceCycleCursor(
  recurrenceType: string | null | undefined,
  recurrenceInterval: number | null | undefined,
  specificWeekday: number | null | undefined,
  currentCycleStart: Date,
  accountingYearStart?: string | null
): Date {
  return calculateNextCycleStartDate(
    recurrenceType,
    recurrenceInterval,
    specificWeekday,
    currentCycleStart,
    accountingYearStart
  );
}

/**
 * SQL expression: UTC calendar day of the daily instance represented by a stored start_date/cursor.
 * Eve-before rows (22:00 UTC) map to the next UTC day.
 */
export function getDailyLogicalInstanceDaySql(columnExpr: string): string {
  const utc = `(${columnExpr} AT TIME ZONE 'UTC')`;
  return `CASE
    WHEN (
      EXTRACT(HOUR FROM ${utc}) = 22
      AND EXTRACT(MINUTE FROM ${utc}) = 0
      AND EXTRACT(SECOND FROM ${utc}) = 0
    ) OR (
      EXTRACT(HOUR FROM ${utc}) = 18
      AND EXTRACT(MINUTE FROM ${utc}) = 30
      AND EXTRACT(SECOND FROM ${utc}) = 0
    )
    THEN (${utc}::date + 1)
    ELSE ${utc}::date
  END`;
}

/** Eve-before cursors (22:00 UTC) store the day before the instance they materialize. */
export function isDailyEveBeforeCursor(cycleCursor: Date): boolean {
  return (
    cycleCursor.getUTCHours() === 22 &&
    cycleCursor.getUTCMinutes() === 0 &&
    cycleCursor.getUTCSeconds() === 0
  );
}

/** UTC calendar day of the instance a daily cursor represents. */
export function resolveDailyLogicalInstanceDay(cycleCursor: Date): Date {
  const cursorDay = startOfUtcCalendarDay(cycleCursor);
  if (isDailyEveBeforeCursor(cycleCursor)) {
    return addUtcCalendarDays(cursorDay, 1);
  }
  return cursorDay;
}

/** Whether catch-up should keep iterating for this template cursor. */
export function shouldContinueRecurrenceCatchup(
  cycleCursor: Date,
  now: Date,
  iterations: number,
  maxIterations: number,
  recurrenceType?: string | null
): boolean {
  if (iterations >= maxIterations) return false;
  const freq = normalizeCycleRecurrenceFrequency(recurrenceType, null);
  if (freq === 'daily') {
    const instanceDay = resolveDailyLogicalInstanceDay(cycleCursor);
    const nowDay = startOfUtcCalendarDay(now);
    return instanceDay.getTime() <= nowDay.getTime();
  }
  return cycleCursor.getTime() <= now.getTime();
}

/** Daily templates: eligible when the logical instance day is on or before today (UTC). */
export function isDailyRecurrenceDue(nextRecurrenceDate: Date, now: Date = new Date()): boolean {
  const instanceDay = resolveDailyLogicalInstanceDay(nextRecurrenceDate);
  const nowDay = startOfUtcCalendarDay(now);
  return instanceDay.getTime() <= nowDay.getTime();
}

/**
 * Map template cursor → instance start for daily recurrence.
 * Supports direct cycle cursors (Jun 2 00:00 → Jun 2) and eve-before storage (Jun 5 22:00 UTC → Jun 6).
 */
export function resolveDailyInstanceStartDate(
  cycleCursor: Date,
  timeSource: Date | null | undefined,
  _now: Date = new Date()
): Date {
  const instanceDay = resolveDailyLogicalInstanceDay(cycleCursor);
  // Daily rows store calendar dates as naive midnight (timestamp without time zone).
  if (!timeSource || isDailyEveBeforeCursor(timeSource)) {
    return instanceDay;
  }
  return applyRecurrenceTimeOfDay(instanceDay, timeSource);
}
