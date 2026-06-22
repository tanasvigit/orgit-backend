export type UserLifecycleCategory =
  | 'scheduled'
  | 'todo'
  | 'inprogress'
  | 'duesoon'
  | 'overdue'
  | 'completed';

export type AssigneeLifecycleInput = {
  assigneeStatus?: string | null;
  verifiedAt?: string | Date | null;
  startDate?: string | Date | null;
  targetDate?: string | Date | null;
  dueDate?: string | Date | null;
  dueSoonDays?: number;
  now?: Date;
};

const toDayStartMs = (input?: string | Date | null): number | null => {
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/** Calendar-day comparison: true when today is strictly before start_date's day. */
export const isBeforeStartDateCalendarDay = (
  startDate?: string | Date | null,
  now?: Date
): boolean => {
  const todayMs = toDayStartMs(now ?? new Date());
  const startMs = toDayStartMs(startDate);
  if (startMs == null || todayMs == null) return false;
  return todayMs < startMs;
};

export const parseDueSoonDays = (value: unknown): number => {
  const n = Number(
    (value as { dueSoonDays?: number })?.dueSoonDays ?? value
  );
  return Number.isFinite(n) && n >= 1 && n <= 30 ? Math.floor(n) : 3;
};

const isExplicitInProgressStatus = (status: string | null | undefined): boolean => {
  const normalized = String(status || '').toLowerCase().trim();
  return (
    normalized === 'inprogress' ||
    normalized === 'in_progress' ||
    normalized === 'pending_verification' ||
    normalized === 'under_verification' ||
    normalized === 'awaiting_creator_confirmation'
  );
};

export const normalizeAssigneeLifecycleStatus = (
  status: string | null | undefined
): UserLifecycleCategory | null => {
  if (!status) return null;
  const normalized = String(status).toLowerCase().trim();

  if (normalized === 'scheduled') return 'scheduled';
  if (normalized === 'todo' || normalized === 'pending' || normalized === 'active' || normalized === 'accepted') {
    return 'todo';
  }
  if (isExplicitInProgressStatus(normalized)) {
    return 'inprogress';
  }
  if (normalized === 'duesoon' || normalized === 'due_soon') return 'duesoon';
  if (normalized === 'overdue') return 'overdue';
  if (normalized === 'completed' || normalized === 'verified' || normalized === 'completed_verified') {
    return 'completed';
  }
  if (normalized === 'rejected') return 'todo';

  return null;
};

export const resolveInitialAssigneeStatus = (
  input: Pick<AssigneeLifecycleInput, 'startDate' | 'now'>
): 'scheduled' | 'todo' => {
  const todayMs = toDayStartMs(input.now ?? new Date());
  const startMs = toDayStartMs(input.startDate);
  if (startMs != null && todayMs != null && todayMs < startMs) {
    return 'scheduled';
  }
  return 'todo';
};

const isDueSoon = (
  todayMs: number,
  dueMs: number,
  dueSoonDays: number
): boolean => {
  const diffDays = Math.ceil((dueMs - todayMs) / (1000 * 60 * 60 * 24));
  return diffDays >= 0 && diffDays <= dueSoonDays;
};

const isDueSoonEligible = (
  todayMs: number,
  startMs: number | null,
  targetMs: number | null,
  dueMs: number | null,
  dueSoonDays: number
): boolean => {
  if (dueMs == null || todayMs == null) return false;
  const gateMs = targetMs ?? startMs;
  if (gateMs != null && todayMs < gateMs) return false;
  return isDueSoon(todayMs, dueMs, dueSoonDays);
};

export const resolveUserLifecycleCategory = (
  input: AssigneeLifecycleInput
): UserLifecycleCategory => {
  const todayMs = toDayStartMs(input.now ?? new Date());
  const startMs = toDayStartMs(input.startDate);
  const targetMs = toDayStartMs(input.targetDate);
  const dueMs = toDayStartMs(input.dueDate);
  // Overdue after due_date when set; otherwise after target_date only.
  const overdueMs = dueMs ?? targetMs;
  const dueSoonDays = input.dueSoonDays ?? 3;
  const rawAssigneeStatus = input.assigneeStatus;

  if (input.verifiedAt) {
    return 'completed';
  }

  const fromStatus = normalizeAssigneeLifecycleStatus(rawAssigneeStatus);
  if (fromStatus === 'completed') {
    return 'inprogress';
  }

  if (startMs != null && todayMs != null && todayMs < startMs) {
    return 'scheduled';
  }

  if (overdueMs != null && todayMs != null && todayMs > overdueMs) {
    return 'overdue';
  }

  if (fromStatus === 'overdue') {
    return 'overdue';
  }

  if (isExplicitInProgressStatus(rawAssigneeStatus)) {
    return 'inprogress';
  }

  if (todayMs != null && isDueSoonEligible(todayMs, startMs, targetMs, dueMs, dueSoonDays)) {
    return 'duesoon';
  }

  if (fromStatus === 'duesoon') {
    return 'todo';
  }

  if (fromStatus === 'scheduled') {
    return 'todo';
  }

  if (fromStatus) {
    return fromStatus;
  }

  return 'todo';
};

export const lifecycleToDashboardBucket = (
  lifecycle: UserLifecycleCategory
): 'scheduled' | 'todo' | 'overdue' | 'dueSoon' | 'inProgress' | 'completed' => {
  switch (lifecycle) {
    case 'scheduled':
      return 'scheduled';
    case 'todo':
      return 'todo';
    case 'duesoon':
      return 'dueSoon';
    case 'overdue':
      return 'overdue';
    case 'completed':
      return 'completed';
  }
  return 'inProgress';
};
