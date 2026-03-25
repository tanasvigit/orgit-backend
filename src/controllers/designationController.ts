import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import { query } from '../config/database';

/**
 * Get all designations for admin's organization
 */
export const getDesignations = async (req: AuthRequest, res: Response) => {
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
      `SELECT DISTINCT designation 
       FROM user_organizations 
       WHERE organization_id = $1 AND designation IS NOT NULL AND designation != ''
       ORDER BY designation ASC`,
      [organizationId]
    );

    // Also check if there's a designations table (if it exists)
    let designationsTable = [];
    try {
      const desigTableResult = await query(
        `SELECT id, name, description, level, created_at 
         FROM designations 
         WHERE organization_id = $1 
         ORDER BY level ASC, name ASC`,
        [organizationId]
      );
      designationsTable = desigTableResult.rows;
    } catch (error: any) {
      // Designations table doesn't exist, use user_organizations data
      // Only log if it's not a "table doesn't exist" error
      if (error?.code !== '42P01') {
        console.error('Error querying designations table:', error);
      }
    }

    // Combine both sources
    const designations = [
      ...designationsTable.map((d: any) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        level: d.level,
        created_at: d.created_at,
      })),
      ...result.rows
        .map((r: any) => r.designation)
        .filter((desig: string, index: number, self: string[]) => self.indexOf(desig) === index)
        .map((desig: string) => ({
          id: null,
          name: desig,
          description: null,
          level: null,
          created_at: null,
        })),
    ];

    res.json({
      success: true,
      data: designations,
    });
  } catch (error: any) {
    console.error('Error getting designations:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get designations',
    });
  }
};

/**
 * Create designation for admin's organization
 */
export const createDesignation = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const { name, description, level } = req.body;

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You are not associated with any organization',
      });
    }

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Designation name is required',
      });
    }

    // Try to insert into designations table if it exists
    try {
      const result = await query(
        `INSERT INTO designations (id, organization_id, name, description, level, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, CURRENT_TIMESTAMP)
         RETURNING id, name, description, level, created_at`,
        [organizationId, name.trim(), description || null, level || null]
      );

      res.status(201).json({
        success: true,
        data: result.rows[0],
      });
    } catch (error: any) {
      // If designations table doesn't exist, just return success
      // The designation will be stored when assigning users
      res.status(201).json({
        success: true,
        data: {
          id: null,
          name: name.trim(),
          description: description || null,
          level: level || null,
          created_at: new Date().toISOString(),
        },
      });
    }
  } catch (error: any) {
    console.error('Error creating designation:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create designation',
    });
  }
};

/**
 * Update designation
 */
export const updateDesignation = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const { id } = req.params;
    const { name, description, level } = req.body;

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You are not associated with any organization',
      });
    }

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Designation name is required',
      });
    }

    try {
      const result = await query(
        `UPDATE designations 
         SET name = $1, description = $2, level = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $4 AND organization_id = $5
         RETURNING id, name, description, level, created_at`,
        [name.trim(), description || null, level || null, id, organizationId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Designation not found',
        });
      }

      res.json({
        success: true,
        data: result.rows[0],
      });
    } catch (error: any) {
      return res.status(404).json({
        success: false,
        error: 'Designation not found or designations table does not exist',
      });
    }
  } catch (error: any) {
    console.error('Error updating designation:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update designation',
    });
  }
};

/**
 * Delete designation
 */
export const deleteDesignation = async (req: AuthRequest, res: Response) => {
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

    // Check if any users are assigned to this designation
    const usersCheck = await query(
      `SELECT COUNT(*) as count 
       FROM user_organizations 
       WHERE organization_id = $1 AND designation = (SELECT name FROM designations WHERE id = $2)`,
      [organizationId, id]
    );

    if (parseInt(usersCheck.rows[0].count) > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete designation. Users are still assigned to it.',
      });
    }

    try {
      const result = await query(
        `DELETE FROM designations 
         WHERE id = $1 AND organization_id = $2
         RETURNING id`,
        [id, organizationId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Designation not found',
        });
      }

      res.json({
        success: true,
        message: 'Designation deleted successfully',
      });
    } catch (error: any) {
      return res.status(404).json({
        success: false,
        error: 'Designation not found or designations table does not exist',
      });
    }
  } catch (error: any) {
    console.error('Error deleting designation:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete designation',
    });
  }
};

