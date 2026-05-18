const NAIVE_LOCAL_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,6})?$/;

/**
 * Clients must send ISO-8601 with timezone (e.g. 2026-05-18T12:00:00.000Z).
 * Naive "YYYY-MM-DD HH:mm:ss" is local wall-clock and must not be stored as-is.
 */
export const getValidatedDeviceTimestamp = (raw?: string | null): Date | null => {
  if (!raw) return null;

  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  // Reject naive local timestamps — they caused cross-platform display drift.
  if (NAIVE_LOCAL_DATETIME_RE.test(trimmed) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    return null;
  }

  const deviceTime = new Date(trimmed).getTime();
  if (Number.isNaN(deviceTime)) {
    return null;
  }

  const serverTime = Date.now();
  const diffMs = deviceTime - serverTime;
  const maxSkewMs = 24 * 60 * 60 * 1000;

  if (Math.abs(diffMs) <= maxSkewMs) {
    return new Date(deviceTime);
  }

  return null;
};

/** Always emit UTC ISO strings to web/mobile clients. */
export const serializeTimestampForClient = (
  value: Date | string | null | undefined
): string | null => {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

