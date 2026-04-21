export const STORED_TASK_STATUSES = [
  'todo',
  'active',
  'in_progress',
  'pending_verification',
  'completed',
  'rejected',
  'deleted',
] as const;

export type StoredTaskStatus = (typeof STORED_TASK_STATUSES)[number];
export type DerivedTaskStatus = StoredTaskStatus | 'due_soon' | 'overdue';

export type TaskStatusContext = {
  id: string;
  status: string | null;
  start_date?: string | Date | null;
  due_date?: string | Date | null;
  deleted_at?: string | Date | null;
};

const toDayStartMs = (input: string | Date | null | undefined): number | null => {
  if (!input) return null;
  const d = new Date(input);
  if (!Number.isFinite(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const normalizeStoredStatus = (status: string | null | undefined): StoredTaskStatus => {
  const normalized = (status || '').toLowerCase().trim();
  if (normalized === 'pending') return 'todo';
  if ((STORED_TASK_STATUSES as readonly string[]).includes(normalized)) {
    return normalized as StoredTaskStatus;
  }
  return 'todo';
};

export const getComputedStatus = (
  task: TaskStatusContext,
  now: Date = new Date()
): { status: StoredTaskStatus; derivedStatus: DerivedTaskStatus } => {
  if (task.deleted_at) {
    return { status: 'deleted', derivedStatus: 'deleted' };
  }

  const status = normalizeStoredStatus(task.status);
  const nowMs = toDayStartMs(now)!;
  const startMs = toDayStartMs(task.start_date);
  const dueMs = toDayStartMs(task.due_date);

  // Auto-open TODO tasks to ACTIVE once start_date is reached.
  const effectiveStatus =
    status === 'todo' && startMs !== null && startMs <= nowMs ? 'active' : status;

  if (
    dueMs !== null &&
    effectiveStatus !== 'completed' &&
    effectiveStatus !== 'rejected' &&
    effectiveStatus !== 'deleted'
  ) {
    const diffDays = Math.floor((dueMs - nowMs) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) {
      return { status: effectiveStatus, derivedStatus: 'overdue' };
    }
    if (diffDays <= 2) {
      return { status: effectiveStatus, derivedStatus: 'due_soon' };
    }
  }

  return { status: effectiveStatus, derivedStatus: effectiveStatus };
};

export const isValidTransition = (
  fromStatusRaw: string | null | undefined,
  toStatusRaw: string | null | undefined
): boolean => {
  const fromStatus = normalizeStoredStatus(fromStatusRaw);
  const toStatus = normalizeStoredStatus(toStatusRaw);

  if (fromStatus === toStatus) return true;

  const allowedTransitions: Record<StoredTaskStatus, StoredTaskStatus[]> = {
    // Allow direct start from TODO when user taps explicit "Mark as In Progress".
    todo: ['active', 'in_progress', 'deleted'],
    active: ['in_progress', 'deleted'],
    in_progress: ['pending_verification', 'deleted'],
    pending_verification: ['completed', 'in_progress', 'deleted'],
    completed: ['deleted'],
    rejected: ['deleted'],
    deleted: [],
  };

  return allowedTransitions[fromStatus].includes(toStatus);
};

