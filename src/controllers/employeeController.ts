import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import { query } from '../config/database';
import bcrypt from 'bcryptjs';

/**
 * Add employee to organization by mobile number
 */
export const addEmployee = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const { mobile, name, department, designation, reportingTo, level, password } = req.body;

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You are not associated with any organization',
      });
    }

    if (!mobile || !/^\+\d{6,20}$/.test(mobile)) {
      return res.status(400).json({
        success: false,
        error: 'Valid mobile number is required (international format: +911234567890)',
      });
    }

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Employee name is required',
      });
    }

    // Check if user already exists
    const existingUser = await query(
      'SELECT id, role FROM users WHERE mobile = $1',
      [mobile]
    );

    let employeeUserId: string;

    if (existingUser.rows.length > 0) {
      // User exists, check if they're already in this organization
      employeeUserId = existingUser.rows[0].id;
      
      const existingOrgCheck = await query(
        'SELECT id FROM user_organizations WHERE user_id = $1 AND organization_id = $2',
        [employeeUserId, organizationId]
      );

      if (existingOrgCheck.rows.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'User is already a member of this organization',
        });
      }

      // Update user role to employee if needed
      if (existingUser.rows[0].role !== 'employee') {
        await query(
          'UPDATE users SET role = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          ['employee', employeeUserId]
        );
      }
    } else {
      // Create new user
    if (!password || password.trim().length < 4) {
      return res.status(400).json({
        success: false,
        error: 'Password is required (minimum 4 characters) for new users',
      });
    }

      const passwordHash = await bcrypt.hash(password, 10);
      
      const newUserResult = await query(
        `INSERT INTO users (id, mobile, name, role, status, password_hash)
         VALUES (gen_random_uuid(), $1, $2, 'employee', 'active', $3)
         RETURNING id, mobile, name, role, status`,
        [mobile, name.trim(), passwordHash]
      );

      employeeUserId = newUserResult.rows[0].id;

      // Create default profile
      await query(
        `INSERT INTO profiles (user_id, about, contact_number)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO NOTHING`,
        [employeeUserId, 'Hey there! I am using OrgIT.', mobile]
      );
    }

    // Add user to organization with department/designation/reporting_to/level
    await query(
      `INSERT INTO user_organizations (id, user_id, organization_id, department, designation, reporting_to, level, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, organization_id) 
       DO UPDATE SET department = $3, designation = $4, reporting_to = $5, level = $6, updated_at = CURRENT_TIMESTAMP`,
      [employeeUserId, organizationId, department || null, designation || null, reportingTo || null, level || null]
    );

    // Get the created/updated user
    const userResult = await query(
      `SELECT u.id, u.mobile, u.name, u.role, u.status, uo.department, uo.designation, uo.reporting_to, uo.level
       FROM users u
       JOIN user_organizations uo ON u.id = uo.user_id
       WHERE u.id = $1 AND uo.organization_id = $2`,
      [employeeUserId, organizationId]
    );

    res.status(201).json({
      success: true,
      data: userResult.rows[0],
      message: existingUser.rows.length > 0 
        ? 'Employee added to organization successfully' 
        : 'Employee created and added to organization successfully',
    });
  } catch (error: any) {
    console.error('Error adding employee:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to add employee',
    });
  }
};

/**
 * Get all employees in admin's organization
 */
export const getEmployees = async (req: AuthRequest, res: Response) => {
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
      `SELECT 
        u.id,
        u.mobile,
        u.name,
        u.role,
        u.status,
        u.profile_photo_url,
        uo.department,
        uo.designation,
        uo.reporting_to,
        uo.level,
        reporter.name as reporting_to_name,
        u.created_at
       FROM users u
       JOIN user_organizations uo ON u.id = uo.user_id
       LEFT JOIN users reporter ON uo.reporting_to = reporter.id
       WHERE uo.organization_id = $1 AND u.role IN ('admin', 'employee')
       ORDER BY u.role DESC, u.name ASC`,
      [organizationId]
    );

    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error: any) {
    console.error('Error getting employees:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get employees',
    });
  }
};

/**
 * Update employee details
 */
export const updateEmployee = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;
    const { id } = req.params;
    const { name, department, designation, reportingTo, level, status } = req.body;

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You are not associated with any organization',
      });
    }

    // Check if employee belongs to admin's organization
    const employeeCheck = await query(
      'SELECT user_id FROM user_organizations WHERE user_id = $1 AND organization_id = $2',
      [id, organizationId]
    );

    if (employeeCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Employee not found in your organization',
      });
    }

    // Update user details
    if (name) {
      await query(
        'UPDATE users SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [name.trim(), id]
      );
    }

    if (status) {
      await query(
        'UPDATE users SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [status, id]
      );
    }

    // Update organization details
    await query(
      `UPDATE user_organizations 
       SET department = COALESCE($1, department), 
           designation = COALESCE($2, designation),
           reporting_to = $3,
           level = COALESCE($4, level),
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $5 AND organization_id = $6`,
      [department || null, designation || null, reportingTo || null, level || null, id, organizationId]
    );

    // Get updated employee
    const result = await query(
      `SELECT u.id, u.mobile, u.name, u.role, u.status, uo.department, uo.designation, uo.reporting_to, uo.level
       FROM users u
       JOIN user_organizations uo ON u.id = uo.user_id
       WHERE u.id = $1 AND uo.organization_id = $2`,
      [id, organizationId]
    );

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error: any) {
    console.error('Error updating employee:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to update employee',
    });
  }
};

/**
 * Reset employee password (admin only)
 */
export const resetEmployeePassword = async (req: AuthRequest, res: Response) => {
  try {
    const organizationId = req.user?.organizationId;
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!organizationId) {
      return res.status(403).json({
        success: false,
        error: 'You are not associated with any organization',
      });
    }

    if (!newPassword || newPassword.trim().length < 4) {
      return res.status(400).json({
        success: false,
        error: 'New password is required and must be at least 4 characters',
      });
    }

    // Check if employee belongs to admin's organization
    const employeeCheck = await query(
      `SELECT u.id, u.name, u.mobile 
       FROM users u
       JOIN user_organizations uo ON u.id = uo.user_id
       WHERE u.id = $1 AND uo.organization_id = $2`,
      [id, organizationId]
    );

    if (employeeCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Employee not found in your organization',
      });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword.trim(), 10);

    // Update password
    await query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [passwordHash, id]
    );

    res.json({
      success: true,
      message: 'Password reset successfully',
    });
  } catch (error: any) {
    console.error('Error resetting employee password:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to reset password',
    });
  }
};

/**
 * Remove employee from organization (deactivate)
 */
export const removeEmployee = async (req: AuthRequest, res: Response) => {
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

    // Check if employee belongs to admin's organization
    const employeeCheck = await query(
      'SELECT user_id FROM user_organizations WHERE user_id = $1 AND organization_id = $2',
      [id, organizationId]
    );

    if (employeeCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Employee not found in your organization',
      });
    }

    // Deactivate user
    await query(
      'UPDATE users SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['inactive', id]
    );

    // Optionally remove from organization (or just deactivate)
    // For now, we'll just deactivate the user
    // Uncomment below to remove from organization completely:
    // await query(
    //   'DELETE FROM user_organizations WHERE user_id = $1 AND organization_id = $2',
    //   [id, organizationId]
    // );

    res.json({
      success: true,
      message: 'Employee deactivated successfully',
    });
  } catch (error: any) {
    console.error('Error removing employee:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to remove employee',
    });
  }
};

/**
 * Search users by mobile number for admin Add Employee form.
 * Looks up active users by matching the last digits of their mobile number,
 * without restricting to the admin's current organization.
 */
export const searchUsersByMobile = async (req: AuthRequest, res: Response) => {
  try {
    const search = (req.query.q as string) || '';
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;

    const trimmed = search.trim();
    if (!trimmed) {
      return res.json({
        success: true,
        data: [],
      });
    }

    // Work with digits only and match on the last 10 digits for robustness
    const digits = trimmed.replace(/\D/g, '');
    if (!digits) {
      return res.json({
        success: true,
        data: [],
      });
    }
    const last10 = digits.length >= 10 ? digits.slice(-10) : digits;

    const result = await query(
      `SELECT 
         id,
         mobile,
         name,
         role,
         status,
         profile_photo_url,
         bio
       FROM users
       WHERE status = 'active'
         AND REPLACE(REPLACE(mobile, ' ', ''), '+', '') LIKE '%' || $1 || '%'
       ORDER BY name ASC
       LIMIT $2`,
      [last10, limit]
    );

    return res.json({
      success: true,
      data: result.rows,
    });
  } catch (error: any) {
    console.error('Error searching users by mobile for admin:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to search users',
    });
  }
};


