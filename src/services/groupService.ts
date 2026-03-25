import { query } from '../config/database';
import { v4 as uuidv4 } from 'uuid';
import { Group, GroupMember } from '../../../shared/src/types';

/**
 * Create a new group
 */
export const createGroup = async (
  createdBy: string,
  name: string | null,
  photoUrl: string | null,
  isTaskGroup: boolean = false,
  taskId: string | null = null
): Promise<Group> => {
  const result = await query(
    `INSERT INTO groups (id, name, photo_url, created_by, is_task_group, task_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     RETURNING *`,
    [name, photoUrl, createdBy, isTaskGroup, taskId]
  );

  return result.rows[0] as Group;
};

/**
 * Get group by ID
 */
export const getGroupById = async (groupId: string, userId: string): Promise<Group | null> => {
  // Check if user is a member
  const memberCheck = await query(
    `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`,
    [groupId, userId]
  );

  if (memberCheck.rows.length === 0) {
    return null;
  }

  const result = await query('SELECT * FROM groups WHERE id = $1', [groupId]);
  return result.rows.length > 0 ? (result.rows[0] as Group) : null;
};

/**
 * Get user's groups
 */
export const getUserGroups = async (userId: string): Promise<Group[]> => {
  const result = await query(
    `SELECT DISTINCT g.*
     FROM groups g
     INNER JOIN group_members gm ON g.id = gm.group_id
     WHERE gm.user_id = $1
     ORDER BY g.updated_at DESC`,
    [userId]
  );

  return result.rows as Group[];
};

/**
 * Add members to a group
 */
export const addGroupMembers = async (
  groupId: string,
  userIds: string[],
  addedBy: string,
  organizationId: string
): Promise<void> => {
  for (const userId of userIds) {
    // Check if member already exists
    const existingResult = await query(
      `SELECT id FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId]
    );

    if (existingResult.rows.length === 0) {
      // Get user's organization
      const userOrgResult = await query(
        `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
        [userId]
      );

      const userOrgId = userOrgResult.rows.length > 0 
        ? userOrgResult.rows[0].organization_id 
        : organizationId;

      await query(
        `INSERT INTO group_members (id, group_id, user_id, organization_id, added_by)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [groupId, userId, userOrgId, addedBy]
      );
    }
  }
};

/**
 * Remove member from a group
 */
export const removeGroupMember = async (
  groupId: string,
  userId: string,
  removedBy: string
): Promise<void> => {
  // Check if remover is group admin or the member themselves
  const memberResult = await query(
    `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`,
    [groupId, removedBy]
  );

  if (memberResult.rows.length === 0) {
    throw new Error('User is not a member of this group');
  }

  const isAdmin = memberResult.rows[0].role === 'admin';
  const isSelf = userId === removedBy;

  if (!isAdmin && !isSelf) {
    throw new Error('Insufficient permissions to remove member');
  }

  await query(
    `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`,
    [groupId, userId]
  );
};

/**
 * Get group members
 */
export const getGroupMembers = async (groupId: string): Promise<GroupMember[]> => {
  const result = await query(
    `SELECT gm.*, u.name as user_name, u.profile_photo_url, u.role as user_role
     FROM group_members gm
     INNER JOIN users u ON gm.user_id = u.id
     WHERE gm.group_id = $1
     ORDER BY gm.added_at ASC`,
    [groupId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    groupId: row.group_id,
    userId: row.user_id,
    organizationId: row.organization_id,
    role: row.role,
    addedBy: row.added_by,
    addedAt: row.added_at,
    userName: row.user_name,
    userProfilePhoto: row.profile_photo_url,
    userRole: row.user_role,
  })) as any[];
};

/**
 * Update group details (name, photo)
 */
export const updateGroup = async (
  groupId: string,
  userId: string,
  name: string | null,
  photoUrl: string | null
): Promise<Group> => {
  // Check if user is group admin
  const memberResult = await query(
    `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`,
    [groupId, userId]
  );

  if (memberResult.rows.length === 0) {
    throw new Error('User is not a member of this group');
  }

  if (memberResult.rows[0].role !== 'admin') {
    throw new Error('Only group admins can update group details');
  }

  const result = await query(
    `UPDATE groups 
     SET name = COALESCE($1, name), 
         photo_url = COALESCE($2, photo_url),
         updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [name, photoUrl, groupId]
  );

  if (result.rows.length === 0) {
    throw new Error('Group not found');
  }

  return result.rows[0] as Group;
};

/**
 * Create task group automatically
 */
export const createTaskGroup = async (
  taskId: string,
  creatorId: string,
  assignedUserIds: string[],
  organizationId: string
): Promise<Group> => {
  // Get task details for group name
  const taskResult = await query('SELECT title FROM tasks WHERE id = $1', [taskId]);
  const taskTitle = taskResult.rows.length > 0 ? taskResult.rows[0].title : 'Task';

  // Create group
  const group = await createGroup(
    creatorId,
    `Task: ${taskTitle}`,
    null,
    true,
    taskId
  );

  // Add all members (creator + assigned users)
  const allMemberIds = [creatorId, ...assignedUserIds];
  await addGroupMembers(group.id, allMemberIds, creatorId, organizationId);

  return group;
};

