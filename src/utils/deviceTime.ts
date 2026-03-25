export const getValidatedDeviceTimestamp = (raw?: string | null): Date | null => {
  if (!raw) return null;

  const deviceTime = new Date(raw).getTime();
  if (Number.isNaN(deviceTime)) {
    return null;
  }

  const serverTime = Date.now();
  const diffMs = deviceTime - serverTime;

  // Allow up to 24 hours clock skew in either direction
  const maxSkewMs = 24 * 60 * 60 * 1000;

  if (Math.abs(diffMs) <= maxSkewMs) {
    return new Date(deviceTime);
  }

  return null;
};

