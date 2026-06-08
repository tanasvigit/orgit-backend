import {
  parseRecurrenceEndPolicy,
  shouldGenerateRecurrenceCycle,
  validateRecurrenceEndPolicyInput,
} from '../recurrenceEndPolicy';

describe('recurrenceEndPolicy', () => {
  it('allows cycles until specific end date (inclusive)', () => {
    const policy = parseRecurrenceEndPolicy({
      recurrence_end_type: 'specific_date',
      recurrence_end_date: '2026-06-10T00:00:00.000Z',
    });
    expect(
      shouldGenerateRecurrenceCycle(policy, new Date('2026-06-10T12:00:00.000Z'), 5)
    ).toBe(true);
    expect(
      shouldGenerateRecurrenceCycle(policy, new Date('2026-06-11T00:00:00.000Z'), 5)
    ).toBe(false);
  });

  it('stops after X total occurrences for daily/weekly/monthly/yearly', () => {
    const policy = parseRecurrenceEndPolicy({
      recurrence_end_type: 'after_occurrences',
      recurrence_after_occurrences: 3,
    });
    expect(shouldGenerateRecurrenceCycle(policy, new Date('2026-06-01'), 0)).toBe(true);
    expect(shouldGenerateRecurrenceCycle(policy, new Date('2026-06-02'), 2)).toBe(true);
    expect(shouldGenerateRecurrenceCycle(policy, new Date('2026-06-03'), 3)).toBe(false);
  });

  it('never ends when type is never', () => {
    const policy = parseRecurrenceEndPolicy({ recurrence_end_type: 'never' });
    expect(shouldGenerateRecurrenceCycle(policy, new Date('2099-01-01'), 999)).toBe(true);
  });

  it('validates required fields per end type', () => {
    expect(
      validateRecurrenceEndPolicyInput(
        parseRecurrenceEndPolicy({ recurrence_end_type: 'specific_date' })
      ).valid
    ).toBe(false);
    expect(
      validateRecurrenceEndPolicyInput(
        parseRecurrenceEndPolicy({
          recurrence_end_type: 'after_occurrences',
          recurrence_after_occurrences: 0,
        })
      ).valid
    ).toBe(false);
    expect(
      validateRecurrenceEndPolicyInput(
        parseRecurrenceEndPolicy({
          recurrence_end_type: 'after_occurrences',
          recurrence_after_occurrences: 5,
        })
      ).valid
    ).toBe(true);
  });
});
