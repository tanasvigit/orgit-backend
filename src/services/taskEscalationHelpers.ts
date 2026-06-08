export type EscalationTrigger = 'target_date' | 'due_date';
export type EscalationWhen = 'before' | 'after' | 'on';

export type EscalationRulesPayload = {
  enabled?: boolean;
  trigger?: string;
  when?: EscalationWhen;
  offset_days?: number;
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

export function normalizeEscalationWhen(value: unknown): EscalationWhen {
  const v = String(value || '').toLowerCase().trim();
  if (v === 'after') return 'after';
  if (v === 'on') return 'on';
  return 'before';
}

export function normalizeEscalationOffsetDays(
  value: unknown,
  when: EscalationWhen = 'before'
): number {
  if (when === 'on') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(365, Math.floor(n));
}

/** Legacy column: days before anchor (before / on only). */
export function escalationWhenToDaysBefore(when: EscalationWhen, offsetDays: number): number {
  if (when === 'before') return offsetDays;
  return 0;
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
  escalation_when?: unknown;
  escalation_offset_days?: unknown;
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

  const when = normalizeEscalationWhen(
    input.escalation_when ?? base.when ?? (base.days_before === 0 ? 'on' : 'before')
  );
  const offsetDays = normalizeEscalationOffsetDays(
    input.escalation_offset_days ??
      input.escalation_days_before ??
      base.offset_days ??
      base.days_before ??
      1,
    when
  );

  return {
    ...base,
    enabled: true,
    trigger: normalizeEscalationTrigger(input.escalation_trigger ?? base.trigger),
    when,
    offset_days: offsetDays,
    days_before: escalationWhenToDaysBefore(when, offsetDays),
    contact_ids: contactIds,
  };
}

export function resolveTaskEscalationConfig(task: {
  escalation_trigger?: string | null;
  escalation_days_before?: number | null;
  escalation_rules?: unknown;
}): { trigger: EscalationTrigger; when: EscalationWhen; offsetDays: number; daysBefore: number } {
  const rules = parseEscalationRules(task.escalation_rules);
  const when = normalizeEscalationWhen(
    rules.when ?? (task.escalation_days_before === 0 ? 'on' : 'before')
  );
  const offsetDays = normalizeEscalationOffsetDays(
    rules.offset_days ?? task.escalation_days_before ?? rules.days_before ?? 0,
    when
  );
  return {
    trigger: normalizeEscalationTrigger(task.escalation_trigger ?? rules.trigger),
    when,
    offsetDays,
    daysBefore: escalationWhenToDaysBefore(when, offsetDays),
  };
}
