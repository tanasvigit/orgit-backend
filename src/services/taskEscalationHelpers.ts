export type EscalationTrigger = 'target_date' | 'due_date';

export type EscalationRulesPayload = {
  enabled?: boolean;
  trigger?: string;
  days_before?: number;
  contact_ids?: string[];
  _metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

export function normalizeEscalationTrigger(value: unknown): EscalationTrigger {
  return value === 'target_date' ? 'target_date' : 'due_date';
}

export function normalizeEscalationDaysBefore(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(365, Math.floor(n));
}

export function parseEscalationRules(raw: unknown): EscalationRulesPayload {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as EscalationRulesPayload)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as EscalationRulesPayload;
  }
  return {};
}

export function buildEscalationRulesFromRequest(input: {
  auto_escalate?: boolean;
  escalation_rules?: unknown;
  escalation_trigger?: unknown;
  escalation_days_before?: unknown;
  escalation_contact_ids?: unknown;
}): EscalationRulesPayload | null {
  const autoEscalate = !!input.auto_escalate;
  if (!autoEscalate) return null;

  const base = parseEscalationRules(input.escalation_rules);
  const contactIds = Array.isArray(input.escalation_contact_ids)
    ? input.escalation_contact_ids.map((id) => String(id)).filter(Boolean)
    : Array.isArray(base.contact_ids)
      ? base.contact_ids.map((id) => String(id)).filter(Boolean)
      : [];

  return {
    ...base,
    enabled: true,
    trigger: normalizeEscalationTrigger(input.escalation_trigger ?? base.trigger),
    days_before: normalizeEscalationDaysBefore(
      input.escalation_days_before ?? base.days_before ?? 0
    ),
    contact_ids: contactIds,
  };
}

export function resolveTaskEscalationConfig(task: {
  escalation_trigger?: string | null;
  escalation_days_before?: number | null;
  escalation_rules?: unknown;
}): { trigger: EscalationTrigger; daysBefore: number } {
  const rules = parseEscalationRules(task.escalation_rules);
  return {
    trigger: normalizeEscalationTrigger(task.escalation_trigger ?? rules.trigger),
    daysBefore: normalizeEscalationDaysBefore(
      task.escalation_days_before ?? rules.days_before ?? 0
    ),
  };
}
