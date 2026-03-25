import { Request, Response } from 'express';
import {
  createGroup,
  getGroupById,
  getUserGroups,
  addGroupMembers,
  removeGroupMember,
  getGroupMembers,
  updateGroup,
} from '../services/groupService';

/**
 * Create a new group
 */
export const createGroupHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { name, photoUrl, memberIds } = req.body;

    const group = await createGroup(userId, name || null, photoUrl || null, false, null);

    // Add members if provided
    if (memberIds && Array.isArray(memberIds) && memberIds.length > 0) {
      const orgResult = await (await import('../config/database')).query(
        `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
        [userId]
      );
      const organizationId = orgResult.rows.length > 0 
        ? orgResult.rows[0].organization_id 
        : '';

      await addGroupMembers(group.id, memberIds, userId, organizationId);
    }

    res.json({
      success: true,
      data: group,
    });
  } catch (error: any) {
    console.error('Create group error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create group',
    });
  }
};

/**
 * Get user's groups
 */
export const getUserGroupsHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const groups = await getUserGroups(userId);

    res.json({
      success: true,
      data: groups,
    });
  } catch (error: any) {
    console.error('Get user groups error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get groups',
    });
  }
};

/**
 * Get group by ID
 */
export const getGroupHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { groupId } = req.params;

    const group = await getGroupById(groupId, userId);

    if (!group) {
      return res.status(404).json({
        success: false,
        error: 'Group not found',
      });
    }

    res.json({
      success: true,
      data: group,
    });
  } catch (error: any) {
    console.error('Get group error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get group',
    });
  }
};

/**
 * Get group members
 */
export const getGroupMembersHandler = async (req: Request, res: Response) => {
  try {
    const { groupId } = req.params;
    const members = await getGroupMembers(groupId);

    res.json({
      success: true,
      data: members,
    });
  } catch (error: any) {
    console.error('Get group members error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get group members',
    });
  }
};

/**
 * Add members to group
 */
export const addMembersHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { groupId } = req.params;
    const { memberIds } = req.body;

    if (!memberIds || !Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'memberIds must be a non-empty array',
      });
    }

    const orgResult = await (await import('../config/database')).query(
      `SELECT organization_id FROM user_organizations WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    const organizationId = orgResult.rows.length > 0 
      ? orgResult.rows[0].organization_id 
      : '';

    await addGroupMembers(groupId, memberIds, userId, organizationId);

    res.json({
      success: true,
      message: 'Members added successfully',
    });
  } catch (error: any) {
    console.error('Add members error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to add members',
    });
  }
};

/**
 * Remove member from group
 */
export const removeMemberHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { groupId, memberId } = req.params;

    await removeGroupMember(groupId, memberId, userId);

    res.json({
      success: true,
      message: 'Member removed successfully',
    });
  } catch (error: any) {
    console.error('Remove member error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to remove member',
    });
  }
};

/**
 * Update group details
 */
export const updateGroupHandler = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.userId;
    const { groupId } = req.params;
    const { name, photoUrl } = req.body;

    const group = await updateGroup(groupId, userId, name || null, photoUrl || null);

    res.json({
      success: true,
      data: group,
    });
  } catch (error: any) {
    console.error('Update group error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to update group',
    });
  }
};

