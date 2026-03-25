const express = require('express');
const pool = require('../database/db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Middleware to check if user is super_admin
const requireSuperAdmin = async (req, res, next) => {
    try {
        const result = await pool.query('SELECT role FROM users WHERE id = $1', [req.user.userId]);
        if (result.rows.length === 0 || result.rows[0].role !== 'super_admin') {
            return res.status(403).json({ error: 'Access denied. Super Admin role required.' });
        }
        next();
    } catch (error) {
        console.error('Role check error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

// Update user role
router.put('/users/:id/role', authenticateToken, requireSuperAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;

        if (!['admin', 'employee', 'super_admin'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role' });
        }

        // Prevent changing own role (optional safety check)
        if (id === req.user.userId) {
            return res.status(400).json({ error: 'Cannot change your own role' });
        }

        const result = await pool.query(
            'UPDATE users SET role = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, name, role',
            [role, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            success: true,
            message: 'Role updated successfully',
            user: result.rows[0],
        });
    } catch (error) {
        console.error('Update role error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
