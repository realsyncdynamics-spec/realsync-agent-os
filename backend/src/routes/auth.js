/**
 * Auth Router — RealSyncDynamics Agent-OS
 *
 * Endpoints:
 *   POST /auth/register        — Create tenant + user, return tokens
 *   POST /auth/login           — Authenticate user, return tokens
 *   POST /auth/refresh         — Exchange refresh token for new access token
 *   POST /auth/logout          — Revoke refresh token (Bearer required)
 *   POST /auth/forgot-password — Request password reset link
 *   POST /auth/reset-password  — Complete password reset with token
 *   GET  /auth/me              — Return current user + tenant (Bearer required)
 *
 * Rate-limiting recommendation:
 *   Apply express-rate-limit to at minimum /auth/login, /auth/register,
 *   /auth/forgot-password, and /auth/reset-password.
 *   Example:
 *     const rateLimit = require('express-rate-limit');
 *     const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
 *     router.use('/login', authLimiter);
 *     router.use('/register', authLimiter);
 */

'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');

const pool   = require('../db');
const stripe = require('../config/stripe');

const router = express.Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JWT_SECRET      = process.env.JWT_SECRET;
const JWT_EXPIRES_IN  = process.env.JWT_EXPIRES_IN || '7d';
const REFRESH_TTL_MS  = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an RFC 9457 Problem Details object.
 */
function problem(status, title, detail, extra = {}) {
  return {
    type: `https://realsync.io/errors/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
    ...extra,
  };
}

/**
 * Validate email format.
 */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).toLowerCase());
}

/**
 * Sign a JWT access token.
 */
function signAccessToken(payload) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Generate a cryptographically random refresh token and its SHA-256 hash.
 * The raw token is sent to the client; only the hash is stored in the DB.
 */
function generateRefreshToken() {
  const raw  = uuidv4() + crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/**
 * Persist a new refresh token row.
 *
 * SQL (for reference):
 *   INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
 *   VALUES ($1, $2, $3, $4, $5)
 *   RETURNING id;
 */
async function storeRefreshToken(client, { userId, tokenHash, ip, userAgent }) {
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  const result = await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, tokenHash, expiresAt, ip || null, userAgent || null]
  );
  return result.rows[0];
}

/**
 * Derive an org slug from an org name.
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/**
 * Compose the public user + tenant payload returned in responses.
 */
function buildAuthResponse({ user, tenant, accessToken, refreshToken }) {
  return {
    user: {
      id:           user.id,
      email:        user.email,
      role:         user.role,
      display_name: user.display_name,
    },
    tenant: {
      id:   tenant.id,
      name: tenant.name,
      plan: tenant.plan,
    },
    access_token:  accessToken,
    refresh_token: refreshToken,
  };
}

/**
 * Extract Bearer token from Authorization header.
 */
function extractBearerToken(req) {
  const auth = req.headers.authorization || '';
  const parts = auth.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return parts[1];
  }
  return null;
}

/**
 * Verify a JWT and return its payload, or throw on failure.
 */
function verifyAccessToken(token) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.verify(token, JWT_SECRET);
}

// ---------------------------------------------------------------------------
// Middleware: require Bearer JWT
// ---------------------------------------------------------------------------

async function authenticate(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json(problem(401, 'Unauthorized', 'Bearer token required.'));
  }
  try {
    req.auth = verifyAccessToken(token);
    next();
  } catch (err) {
    return res.status(401).json(problem(401, 'Unauthorized', 'Invalid or expired access token.'));
  }
}

// ---------------------------------------------------------------------------
// POST /auth/register
// ---------------------------------------------------------------------------

router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name, org_name, plan = 'free' } = req.body;

    // --- Validation ---
    if (!email || !isValidEmail(email)) {
      return res.status(400).json(problem(400, 'Bad Request', 'A valid email address is required.'));
    }
    if (!password || password.length < 8) {
      return res.status(400).json(problem(400, 'Bad Request', 'Password must be at least 8 characters.'));
    }
    if (!name) {
      return res.status(400).json(problem(400, 'Bad Request', 'display_name (name) is required.'));
    }
    if (!org_name) {
      return res.status(400).json(problem(400, 'Bad Request', 'org_name is required.'));
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check for existing email
      const existing = await client.query(
        'SELECT id FROM users WHERE email = $1',
        [email.toLowerCase()]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json(problem(409, 'Conflict', 'An account with this email already exists.'));
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 12);

      // Create tenant
      const slug = slugify(org_name);
      const tenantResult = await client.query(
        `INSERT INTO tenants (name, slug, plan)
         VALUES ($1, $2, $3)
         RETURNING id, name, slug, plan`,
        [org_name, slug, plan]
      );
      const tenant = tenantResult.rows[0];

      // Create user
      const userResult = await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, role, display_name)
         VALUES ($1, $2, $3, 'admin', $4)
         RETURNING id, email, role, display_name`,
        [tenant.id, email.toLowerCase(), passwordHash, name]
      );
      const user = userResult.rows[0];

      // Create Stripe customer
      let stripeCustomerId = null;
      try {
        const customer = await stripe.customers.create({
          email:    email.toLowerCase(),
          name:     org_name,
          metadata: { tenant_id: tenant.id },
        });
        stripeCustomerId = customer.id;
      } catch (stripeErr) {
        console.error('[auth/register] Stripe customer creation failed:', stripeErr.message);
        // Non-fatal: proceed without Stripe customer
      }

      // Update tenant with stripe_customer_id
      if (stripeCustomerId) {
        await client.query(
          'UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2',
          [stripeCustomerId, tenant.id]
        );
        tenant.stripe_customer_id = stripeCustomerId;
      }

      // Generate tokens
      const accessToken = signAccessToken({
        sub:       user.id,
        tenant_id: tenant.id,
        role:      user.role,
        email:     user.email,
      });

      const { raw: refreshRaw, hash: refreshHash } = generateRefreshToken();

      /*
       * SQL (for reference):
       * INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
       * VALUES ($1, $2, $3, $4, $5);
       */
      await storeRefreshToken(client, {
        userId:    user.id,
        tokenHash: refreshHash,
        ip:        req.ip,
        userAgent: req.headers['user-agent'],
      });

      await client.query('COMMIT');

      return res.status(201).json(
        buildAuthResponse({ user, tenant, accessToken, refreshToken: refreshRaw })
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

// RATE LIMIT RECOMMENDATION: Apply express-rate-limit here (e.g., 10 req / 15 min per IP).

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json(problem(400, 'Bad Request', 'email and password are required.'));
    }

    // Fetch user + tenant in one query
    const result = await pool.query(
      `SELECT
         u.id, u.email, u.password_hash, u.role, u.display_name,
         t.id   AS tenant_id,
         t.name AS tenant_name,
         t.plan AS tenant_plan
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1`,
      [email.toLowerCase()]
    );

    const row = result.rows[0];

    // Use bcrypt compare even when user not found to avoid timing oracle.
    const DUMMY_HASH = '$2b$12$invalidsaltinvalidsaltinvalidsaltinvalidsaltinvalidsalt';
    const passwordHash = row ? row.password_hash : DUMMY_HASH;
    const passwordMatch = await bcrypt.compare(password, passwordHash);

    if (!row || !passwordMatch) {
      return res.status(401).json(problem(401, 'Unauthorized', 'Invalid email or password.'));
    }

    const user = {
      id:           row.id,
      email:        row.email,
      role:         row.role,
      display_name: row.display_name,
    };
    const tenant = {
      id:   row.tenant_id,
      name: row.tenant_name,
      plan: row.tenant_plan,
    };

    // Generate tokens
    const accessToken = signAccessToken({
      sub:       user.id,
      tenant_id: tenant.id,
      role:      user.role,
      email:     user.email,
    });

    const { raw: refreshRaw, hash: refreshHash } = generateRefreshToken();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      /*
       * SQL (for reference):
       * INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
       * VALUES ($1, $2, $3, $4, $5);
       */
      await storeRefreshToken(client, {
        userId:    user.id,
        tokenHash: refreshHash,
        ip:        req.ip,
        userAgent: req.headers['user-agent'],
      });

      // Update last login timestamp
      await client.query(
        'UPDATE users SET last_login_at = NOW() WHERE id = $1',
        [user.id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return res.json(
      buildAuthResponse({ user, tenant, accessToken, refreshToken: refreshRaw })
    );
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/refresh
// ---------------------------------------------------------------------------

router.post('/refresh', async (req, res, next) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json(problem(400, 'Bad Request', 'refresh_token is required.'));
    }

    const tokenHash = crypto.createHash('sha256').update(refresh_token).digest('hex');

    // Look up token in DB
    const tokenResult = await pool.query(
      `SELECT
         rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
         u.email, u.role,
         t.id AS tenant_id
       FROM refresh_tokens rt
       JOIN users   u ON u.id = rt.user_id
       JOIN tenants t ON t.id = u.tenant_id
       WHERE rt.token_hash = $1`,
      [tokenHash]
    );

    const tokenRow = tokenResult.rows[0];

    if (!tokenRow) {
      return res.status(401).json(problem(401, 'Unauthorized', 'Invalid refresh token.'));
    }
    if (tokenRow.revoked_at) {
      return res.status(401).json(problem(401, 'Unauthorized', 'Refresh token has been revoked.'));
    }
    if (new Date(tokenRow.expires_at) < new Date()) {
      return res.status(401).json(problem(401, 'Unauthorized', 'Refresh token has expired.'));
    }

    // Issue new access token
    const newAccessToken = signAccessToken({
      sub:       tokenRow.user_id,
      tenant_id: tokenRow.tenant_id,
      role:      tokenRow.role,
      email:     tokenRow.email,
    });

    // Refresh token rotation: revoke old, issue new
    const { raw: newRefreshRaw, hash: newRefreshHash } = generateRefreshToken();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Revoke old refresh token
      await client.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1',
        [tokenRow.id]
      );

      /*
       * SQL (for reference):
       * INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip, user_agent)
       * VALUES ($1, $2, $3, $4, $5);
       */
      await storeRefreshToken(client, {
        userId:    tokenRow.user_id,
        tokenHash: newRefreshHash,
        ip:        req.ip,
        userAgent: req.headers['user-agent'],
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return res.json({
      access_token:  newAccessToken,
      refresh_token: newRefreshRaw,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------

router.post('/logout', authenticate, async (req, res, next) => {
  try {
    const { refresh_token } = req.body;

    if (refresh_token) {
      const tokenHash = crypto.createHash('sha256').update(refresh_token).digest('hex');

      /*
       * SQL (for reference):
       * UPDATE refresh_tokens
       * SET revoked_at = NOW()
       * WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL;
       */
      await pool.query(
        `UPDATE refresh_tokens
         SET revoked_at = NOW()
         WHERE token_hash = $1
           AND user_id   = $2
           AND revoked_at IS NULL`,
        [tokenHash, req.auth.sub]
      );
    } else {
      // Revoke ALL refresh tokens for this user if no specific token provided
      await pool.query(
        `UPDATE refresh_tokens
         SET revoked_at = NOW()
         WHERE user_id  = $1
           AND revoked_at IS NULL`,
        [req.auth.sub]
      );
    }

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/forgot-password
// ---------------------------------------------------------------------------

// RATE LIMIT RECOMMENDATION: Apply strict rate-limit (e.g., 5 req / hour per IP).

router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;

    // Always return the same response to prevent user enumeration.
    const SAFE_RESPONSE = {
      message: 'If this email exists, a reset link was sent.',
    };

    if (!email || !isValidEmail(email)) {
      // Still return 200 with safe message
      return res.json(SAFE_RESPONSE);
    }

    const userResult = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      // User does not exist; return safe response without revealing that
      return res.json(SAFE_RESPONSE);
    }

    const userId = userResult.rows[0].id;

    // Generate reset token
    const rawToken   = crypto.randomBytes(32).toString('hex');
    const tokenHash  = crypto.createHash('sha256').update(rawToken).digest('hex');

    /*
     * SQL (for reference):
     * INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     * VALUES ($1, $2, NOW() + INTERVAL '1 hour')
     * ON CONFLICT DO NOTHING;
     *
     * Optionally, invalidate existing tokens first:
     * DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL;
     */
    // Invalidate any existing unused reset tokens for this user
    await pool.query(
      `DELETE FROM password_reset_tokens
       WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    );

    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
      [userId, tokenHash]
    );

    // Build reset URL
    const resetUrl = `${process.env.FRONTEND_URL || 'https://app.realsync.io'}/reset-password?token=${rawToken}`;

    // TODO: Send email via SMTP / transactional email provider (e.g., SendGrid, Postmark, SES).
    //       Replace this console.log with an actual email send:
    //
    //       await sendEmail({
    //         to:      email,
    //         subject: 'Reset your RealSyncDynamics password',
    //         html:    `<p>Click <a href="${resetUrl}">here</a> to reset your password. Link expires in 1 hour.</p>`,
    //       });
    console.log(`[auth/forgot-password] Password reset URL for ${email}: ${resetUrl}`);

    return res.json(SAFE_RESPONSE);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /auth/reset-password
// ---------------------------------------------------------------------------

router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, new_password } = req.body;

    if (!token) {
      return res.status(400).json(problem(400, 'Bad Request', 'token is required.'));
    }
    if (!new_password || new_password.length < 8) {
      return res.status(400).json(problem(400, 'Bad Request', 'new_password must be at least 8 characters.'));
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Validate token
    const tokenResult = await pool.query(
      `SELECT id, user_id, expires_at, used_at
       FROM password_reset_tokens
       WHERE token_hash = $1`,
      [tokenHash]
    );

    const tokenRow = tokenResult.rows[0];

    if (!tokenRow) {
      return res.status(400).json(problem(400, 'Bad Request', 'Invalid or expired reset token.'));
    }
    if (tokenRow.used_at) {
      return res.status(400).json(problem(400, 'Bad Request', 'This reset token has already been used.'));
    }
    if (new Date(tokenRow.expires_at) < new Date()) {
      return res.status(400).json(problem(400, 'Bad Request', 'Reset token has expired.'));
    }

    const newPasswordHash = await bcrypt.hash(new_password, 12);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update password
      await client.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [newPasswordHash, tokenRow.user_id]
      );

      // Mark reset token as used
      await client.query(
        'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1',
        [tokenRow.id]
      );

      /*
       * SQL (for reference):
       * UPDATE refresh_tokens
       * SET revoked_at = NOW()
       * WHERE user_id = $1 AND revoked_at IS NULL;
       */
      // Invalidate all refresh tokens for this user (force re-login everywhere)
      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = NOW()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [tokenRow.user_id]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id, u.email, u.role, u.display_name,
         t.id   AS tenant_id,
         t.name AS tenant_name,
         t.plan AS tenant_plan
       FROM users   u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`,
      [req.auth.sub]
    );

    const row = result.rows[0];
    if (!row) {
      return res.status(404).json(problem(404, 'Not Found', 'User not found.'));
    }

    return res.json({
      user: {
        id:           row.id,
        email:        row.email,
        role:         row.role,
        display_name: row.display_name,
      },
      tenant: {
        id:   row.tenant_id,
        name: row.tenant_name,
        plan: row.tenant_plan,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------

module.exports = router;
