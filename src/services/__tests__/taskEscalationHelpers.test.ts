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
      escalation_days_before: 2,
      escalation_contact_ids: ['u1', 'u2'],
    });
    expect(rules).toMatchObject({
      enabled: true,
      trigger: 'target_date',
      days_before: 2,
      contact_ids: ['u1', 'u2'],
    });
  });

  it('resolves trigger and days from columns or rules json', () => {
    expect(
      resolveTaskEscalationConfig({
        escalation_trigger: null,
        escalation_days_before: null,
        escalation_rules: { trigger: 'due_date', days_before: 3 },
      })
    ).toEqual({ trigger: 'due_date', daysBefore: 3 });
  });

  it('normalizes invalid trigger to due_date', () => {
    expect(normalizeEscalationTrigger('invalid')).toBe('due_date');
    expect(normalizeEscalationDaysBefore(-5)).toBe(0);
    expect(normalizeEscalationDaysBefore('2')).toBe(2);
  });
});
