/**
 * routes/admin.js — admin user management for Nucleus Phone RBAC.
 *
 * Mounted at /api/admin. The mount point applies apiKeyAuth + rbac('admin'),
 * so every handler here can assume req.user is at least admin.
 *
 * Endpoints:
 *   GET  /api/admin/users               — list all users (active + inactive)
 *   POST /api/admin/users               — provision a new user
 *   POST /api/admin/users/:id/deactivate — instant revocation
 *   POST /api/admin/users/:id/reactivate — re-enable a deactivated user
 *   POST /api/admin/users/:id/role       — change a user's role
 */

const { Router } = require('express');
const { pool } = require('../db');
const { invalidateUser } = require('../middleware/auth');
const { isValidEmail } = require('../lib/validators');

const router = Router();

const VALID_ROLES = new Set(['external_caller', 'caller', 'admin']);
const IDENTITY_RE = /^[a-z0-9_-]{2,32}$/;

// GET /api/admin/users — full user list, admins see everything
router.get('/users', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, identity, role, display_name, is_active, created_at, updated_at
       FROM nucleus_phone_users
       ORDER BY is_active DESC, role DESC, email ASC`
    );
    res.json({ users: rows });
  } catch (err) {
    console.error('[admin] list users failed:', err.message);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// POST /api/admin/users — provision a new user
//   body: { email, identity, role, displayName }
router.post('/users', async (req, res) => {
  const { email, identity, role, displayName } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  if (!identity || !IDENTITY_RE.test(identity)) {
    return res.status(400).json({ error: 'identity must match [a-z0-9_-]{2,32}' });
  }
  if (!role || !VALID_ROLES.has(role)) {
    return res.status(400).json({ error: `role must be one of ${[...VALID_ROLES].join(', ')}` });
  }
  if (!displayName || typeof displayName !== 'string') {
    return res.status(400).json({ error: 'displayName required' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO nucleus_phone_users (email, identity, role, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, identity, role, display_name, is_active`,
      [email.toLowerCase(), identity, role, displayName]
    );
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email or identity already exists' });
    }
    console.error('[admin] create user failed:', err.message);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// POST /api/admin/users/:id/deactivate — instant revocation
router.post('/users/:id/deactivate', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'id must be an integer' });
  if (req.user.id === id) {
    return res.status(409).json({ error: 'Cannot deactivate yourself' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE nucleus_phone_users SET is_active = FALSE WHERE id = $1
       RETURNING id, email, identity, is_active`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    // Purge the auth cache so revocation takes effect on the *next* request,
    // not after the 5s cache window.
    invalidateUser(id);

    res.json({ user: rows[0] });
  } catch (err) {
    console.error('[admin] deactivate failed:', err.message);
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

// POST /api/admin/users/:id/reactivate — re-enable a deactivated user
router.post('/users/:id/reactivate', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'id must be an integer' });

  try {
    const { rows } = await pool.query(
      `UPDATE nucleus_phone_users SET is_active = TRUE WHERE id = $1
       RETURNING id, email, identity, is_active`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    invalidateUser(id);
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('[admin] reactivate failed:', err.message);
    res.status(500).json({ error: 'Failed to reactivate user' });
  }
});

// POST /api/admin/users/:id/role — change a user's role
router.post('/users/:id/role', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'id must be an integer' });

  const { role } = req.body || {};
  if (!role || !VALID_ROLES.has(role)) {
    return res.status(400).json({ error: `role must be one of ${[...VALID_ROLES].join(', ')}` });
  }
  if (req.user.id === id && role !== 'admin') {
    return res.status(409).json({ error: 'Cannot demote yourself from admin' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE nucleus_phone_users SET role = $1 WHERE id = $2
       RETURNING id, email, identity, role`,
      [role, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    invalidateUser(id);
    res.json({ user: rows[0] });
  } catch (err) {
    console.error('[admin] role change failed:', err.message);
    res.status(500).json({ error: 'Failed to change role' });
  }
});

module.exports = router;
