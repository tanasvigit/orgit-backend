import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import { query } from '../config/database';

/**
 * Get all departments for admin's organization
 */
export const getDepartments = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You are not associated with any organization',
      });
    }

    const result = await query(
      `SELECT DISTINCT department 
       FROM user_organizations 
       WHERE organization_id = $1 AND department IS NOT NULL AND department != ''
       ORDER BY department ASC`,
      [organizationId]
    );

    // Also check if there's a departments table (if it exists)
    let departmentsTable = [];
    try {
      const deptTableResult = await query(
        `SELECT id, name, description, created_at 
         FROM departments 
         WHERE organization_id = $1 
         ORDER BY name ASC`,
        [organizationId]
      );
      departmentsTable = deptTableResult.rows;
    } catch (error: any) {
      // Departments table doesn't exist, use user_organizations data
      // Only log if it's not a "table doesn't exist" error
      if (error?.code !== '42P01') {
        console.error('Error querying departments table:', error);
      }
    }

    // Combine both sources
    const departments = [
      ...departmentsTable.map((d: any) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        created_at: d.created_at,
      })),
      ...result.rows
        .map((r: any) => r.department)
        .filter((dept: string, index: number, self: string[]) => self.indexOf(dept) === index)
        .map((dept: string) => ({
          id: null,
          name: dept,
          description: null,
          created_at: null,
        })),
    ];

    res.json({
      success: true,
      data: departments,
    });
  } catch (error: any) {
    console.error('Error getting departments:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get departments',
    });
  }
};

/**
 * Create department for admin's organization
 */
export const createDepartment = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const { name, description } = req.body;

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You are not associated with any organization',
      });
    }

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Department name is required',
      });
    }

    // Try to insert into departments table if it exists
    try {
      const result = await query(
        `INSERT INTO departments (id, organization_id, name, description, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, CURRENT_TIMESTAMP)
         RETURNING id, name, description, created_at`,
        [organizationId, name.trim(), description || null]
      );

      res.status(201).json({
        success: true,
        data: result.rows[0],
      });
    } catch (error: any) {
      // If departments table doesn't exist, just return success
      // The department will be stored when assigning users
      res.status(201).json({
        success: true,
        data: {
          id: null,
          name: name.trim(),
          description: description || null,
          created_at: new Date().toISOString(),
        },
      });
    }
  } catch (error: any) {
    console.error('Error creating department:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create department',
    });
  }
};

/**
 * Update department
 */
export const updateDepartment = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const { id } = req.params;
    const { name, description } = req.body;

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You are not associated with any organization',
      });
    }

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Department name is required',
      });
    }

    try {
      const result = await query(
        `UPDATE departments 
         SET name = $1, description = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND organization_id = $4
         RETURNING id, name, description, created_at`,
        [name.trim(), description || null, id, organizationId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Department not found',
        });
      }

      res.json({
        success: true,
        data: result.rows[0],
      });
    } catch (error: any) {
      return res.status(404).json({
        success: false,
        error: 'Department not found or departments table does not exist',
      });
    }
  } catch (error: any) {
    console.error('Error updating department:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update department',
    });
  }
};

/**
 * Delete department
 */
export const deleteDepartment = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const { id } = req.params;

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You are not associated with any organization',
      });
    }

    // Check if any users are assigned to this department
    const usersCheck = await query(
      `SELECT COUNT(*) as count 
       FROM user_organizations 
       WHERE organization_id = $1 AND department = (SELECT name FROM departments WHERE id = $2)`,
      [organizationId, id]
    );

    if (parseInt(usersCheck.rows[0].count) > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete department. Users are still assigned to it.',
      });
    }

    try {
      const result = await query(
        `DELETE FROM departments 
         WHERE id = $1 AND organization_id = $2
         RETURNING id`,
        [id, organizationId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Department not found',
        });
      }

      res.json({
        success: true,
        message: 'Department deleted successfully',
      });
    } catch (error: any) {
      return res.status(404).json({
        success: false,
        error: 'Department not found or departments table does not exist',
      });
    }
  } catch (error: any) {
    console.error('Error deleting department:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete department',
    });
  }
};

