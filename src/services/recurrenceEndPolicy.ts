import { startOfUtcCalendarDay } from './cycleStartRecurrence';

export type RecurrenceEndType = 'never' | 'specific_date' | 'after_occurrences';

export type RecurrenceEndPolicy = {
  endType: RecurrenceEndType;
  endDate: Date | null;
  maxOccurrences: number;
};

export type RecurrenceEndSource = {
  recurrence_end_type?: string | null;
  recurrence_end_date?: Date | string | null;
  recurrence_after_occurrences?: number | string | null;
};

export function normalizeRecurrenceEndType(raw: unknown): RecurrenceEndType {
  const value = String(raw ?? 'never')
    .trim()
    .toLowerCase();
  if (value === 'specific_date' || value === 'specific date') return 'specific_date';
  if (value === 'after_occurrences' || value === 'after occurrences' || value === 'after_x_occurrences') {
    return 'after_occurrences';
  }
  return 'never';
}

export function parseRecurrenceEndPolicy(source: RecurrenceEndSource): RecurrenceEndPolicy {
  const endType = normalizeRecurrenceEndType(source.recurrence_end_type);
  const endDateRaw = source.recurrence_end_date;
  const endDate =
    endDateRaw != null && String(endDateRaw).trim() !== '' ? new Date(endDateRaw) : null;
  const maxOccurrences = Math.max(0, Number(source.recurrence_after_occurrences) || 0);

  return {
    endType,
    endDate: endDate && !Number.isNaN(endDate.getTime()) ? endDate : null,
    maxOccurrences,
  };
}

export function validateRecurrenceEndPolicyInput(
  policy: RecurrenceEndPolicy
): { valid: true } | { valid: false; error: string } {
  if (policy.endType === 'specific_date') {
    if (!policy.endDate) {
      return { valid: false, error: 'Recurrence end date is required when ending on a specific date.' };
    }
  }
  if (policy.endType === 'after_occurrences') {
    if (!policy.maxOccurrences || policy.maxOccurrences < 1) {
      return {
        valid: false,
        error: 'Number of occurrences must be at least 1 when ending after X occurrences.',
      };
    }
  }
  return { valid: true };
}

/**
 * Whether another instance should be generated for this cycle start.
 * existingInstanceCount = instances already stored (including the first instance).
 */
export function shouldGenerateRecurrenceCycle(
  policy: RecurrenceEndPolicy,
  cycleStart: Date,
  existingInstanceCount: number
): boolean {
  if (policy.endType === 'never') return true;

  if (policy.endType === 'specific_date' && policy.endDate) {
    const cycleDay = startOfUtcCalendarDay(cycleStart).getTime();
    const endDay = startOfUtcCalendarDay(policy.endDate).getTime();
    return cycleDay <= endDay;
  }

  if (policy.endType === 'after_occurrences') {
    if (policy.maxOccurrences < 1) return true;
    return existingInstanceCount < policy.maxOccurrences;
  }

  return true;
}

export function buildRecurrenceEndFieldsForStorage(
  endType: RecurrenceEndType,
  endDate: Date | string | null | undefined,
  maxOccurrences: number | null | undefined
): {
  recurrence_end_type: RecurrenceEndType;
  recurrence_end_date: string | null;
  recurrence_after_occurrences: number | null;
} {
  return {
    recurrence_end_type: endType,
    recurrence_end_date: endType === 'specific_date' && endDate ? new Date(endDate).toISOString() : null,
    recurrence_after_occurrences:
      endType === 'after_occurrences' && maxOccurrences && maxOccurrences > 0 ? maxOccurrences : null,
  };
}
