export type MemberStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'VERIFIED';

export type TaskStatus =
  | 'TODO'
  | 'IN_PROGRESS'
  | 'UNDER_VERIFICATION'
  | 'AWAITING_CREATOR_CONFIRMATION'
  | 'COMPLETED';

type AssigneeLike = {
  id?: string;
  user_id?: string;
  userId?: string;
  accepted_at?: string | Date | null;
  completed_at?: string | Date | null;
  verified_at?: string | Date | null;
  /** From task_assignees.status: todo, inprogress, duesoon, overdue, completed, scheduled */
  assignee_status?: string | null;
  /** From task_assignees.role: creator, reporting_member, member */
  role?: string | null;
};

type TaskLike = {
  id?: string;
  created_by?: string;
  creator_id?: string;
  reporting_member_id?: string | null;
};

export interface ComputedStatuses {
  taskStatus: TaskStatus;
  memberStatuses: Record<string, MemberStatus>;
  currentUserMemberStatus?: MemberStatus;
}

const toMemberStatus = (assignee: AssigneeLike): MemberStatus => {
  if (assignee.verified_at) {
    return 'VERIFIED';
  }
  if (assignee.completed_at) {
    return 'COMPLETED';
  }
  // Prefer task_assignees.status (assignee_status) when present so API matches DB
  const raw = (assignee.assignee_status || '').toLowerCase();
  if (raw === 'completed') return 'COMPLETED';
  if (raw === 'inprogress' || raw === 'duesoon' || raw === 'overdue') return 'IN_PROGRESS';
  if (raw === 'todo' || raw === 'scheduled') return 'PENDING';
  // Fallback to accepted_at/completed_at
  if (assignee.accepted_at) {
    return 'IN_PROGRESS';
  }
  return 'PENDING';
};

const getUserId = (a: AssigneeLike): string | undefined => {
  const raw = (a.id || a.user_id || (a as any).userId) as string | undefined;
  return raw ? String(raw) : undefined;
};

export const computeTaskAndMemberStatuses = (
  task: TaskLike,
  assignees: AssigneeLike[],
  currentUserId?: string
): ComputedStatuses => {
  const memberStatuses: Record<string, MemberStatus> = {};

  for (const a of assignees || []) {
    const uid = getUserId(a);
    if (!uid) continue;
    memberStatuses[uid] = toMemberStatus(a);
  }

  const creatorFromAssignees = (assignees || []).find(
    (a) => (a?.role || '').toLowerCase() === 'creator'
  );
  const reportingFromAssignees = (assignees || []).find(
    (a) => (a?.role || '').toLowerCase() === 'reporting_member'
  );

  const creatorIdFromRoles = creatorFromAssignees ? getUserId(creatorFromAssignees) : undefined;
  const reportingIdFromRoles = reportingFromAssignees ? getUserId(reportingFromAssignees) : undefined;

  const creatorIdRaw = (task.created_by || task.creator_id) as string | undefined;
  const creatorId = (creatorIdFromRoles || (creatorIdRaw ? String(creatorIdRaw) : undefined)) as
    | string
    | undefined;
  const reportingIdRaw = task.reporting_member_id as string | undefined | null;
  const reportingId = (reportingIdFromRoles || (reportingIdRaw ? String(reportingIdRaw) : undefined)) as
    | string
    | undefined;

  const memberEntries = Object.entries(memberStatuses);

  const creatorStatus = creatorId ? memberStatuses[creatorId] : undefined;
  const reportingStatus = reportingId ? memberStatuses[reportingId] : undefined;

  const nonCreatorMembers = memberEntries.filter(
    ([uid]) => !creatorId || uid !== creatorId
  );

  const anyAcceptedOrBeyond = memberEntries.some(
    ([, status]) => status === 'IN_PROGRESS' || status === 'COMPLETED' || status === 'VERIFIED'
  );

  const completedNonCreatorMembers = nonCreatorMembers.filter(
    ([, status]) => status === 'COMPLETED' || status === 'VERIFIED'
  );
  const anyCompletedNonCreator = completedNonCreatorMembers.length > 0;
  const anyCompletedNonCreatorUnverified = completedNonCreatorMembers.some(
    ([uid, status]) => status === 'COMPLETED' && (!reportingId || uid !== reportingId)
  );

  const allCompletedNonCreatorVerified =
    anyCompletedNonCreator &&
    completedNonCreatorMembers.every(([, status]) => status === 'VERIFIED');

  let taskStatus: TaskStatus;

  if (creatorStatus === 'COMPLETED' || creatorStatus === 'VERIFIED') {
    taskStatus = 'COMPLETED';
  } else if (anyCompletedNonCreatorUnverified) {
    taskStatus = 'UNDER_VERIFICATION';
  } else if (
    anyCompletedNonCreator &&
    allCompletedNonCreatorVerified &&
    (reportingStatus === 'VERIFIED' || !reportingId)
  ) {
    taskStatus = 'AWAITING_CREATOR_CONFIRMATION';
  } else if (anyAcceptedOrBeyond) {
    taskStatus = 'IN_PROGRESS';
  } else {
    taskStatus = 'TODO';
  }

  const currentKey = currentUserId ? String(currentUserId) : undefined;
  const currentUserMemberStatus = currentKey
    ? memberStatuses[currentKey]
    : undefined;

  return {
    taskStatus,
    memberStatuses,
    currentUserMemberStatus,
  };
};

