import {
  buildEscalationRulesFromRequest,
  normalizeEscalationDaysBefore,
  normalizeEscalationTrigger,
  resolveTaskEscalationConfig,
} from '../taskEscalationHelpers';

describe('taskEscalationHelpers', () => {
  it('builds rules from create-task payload', () => {
    const rules = buildEscalationRulesFromRequest({
      auto_escalate: true,
      escalation_trigger: 'target_date',
      escalation_when: 'before',
      escalation_offset_days: 2,
      escalation_contact_ids: ['u1', 'u2'],
    });
    expect(rules).toMatchObject({
      enabled: true,
      trigger: 'target_date',
      when: 'before',
      offset_days: 2,
      days_before: 2,
      contact_ids: ['u1', 'u2'],
    });
  });

  it('builds after/on escalation schedules', () => {
    expect(
      buildEscalationRulesFromRequest({
        auto_escalate: true,
        escalation_when: 'after',
        escalation_offset_days: 3,
      })
    ).toMatchObject({ when: 'after', offset_days: 3, days_before: 0 });

    expect(
      buildEscalationRulesFromRequest({
        auto_escalate: true,
        escalation_when: 'on',
        escalation_offset_days: 5,
      })
    ).toMatchObject({ when: 'on', offset_days: 0, days_before: 0 });
  });

  it('resolves trigger and days from columns or rules json', () => {
    expect(
      resolveTaskEscalationConfig({
        escalation_trigger: null,
        escalation_days_before: null,
        escalation_rules: { trigger: 'due_date', days_before: 3 },
      })
    ).toEqual({ trigger: 'due_date', when: 'before', offsetDays: 3, daysBefore: 3 });
  });

  it('normalizes invalid trigger to due_date', () => {
    expect(normalizeEscalationTrigger('invalid')).toBe('due_date');
    expect(normalizeEscalationDaysBefore(-5)).toBe(0);
    expect(normalizeEscalationDaysBefore('2')).toBe(2);
  });
});
