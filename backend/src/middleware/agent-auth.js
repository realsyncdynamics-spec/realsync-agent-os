/**
 * Agent Internal Auth Middleware
 * Protects /agent/* endpoints with a shared secret key.
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * Usage in app.js:
 *   const { agentAuth } = require('./middleware/agent-auth');
 *   app.use('/agent', agentAuth);
 */

const crypto = require('crypto');

/**
 * Timing-safe string comparison helper.
 * Returns true only when both strings are equal in length and content,
 * without leaking timing information.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;

  // Buffer both strings with the same encoding to prevent length-based leaks.
  // crypto.timingSafeEqual requires equal-length buffers.
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  if (bufA.length !== bufB.length) {
    // Perform a dummy comparison so we don't short-circuit on length,
    // then return false. (Length difference itself is not a timing leak here
    // because both key and expected come from controlled env vars.)
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Express middleware that validates the X-Agent-Key header against
 * the AGENT_INTERNAL_KEY environment variable.
 *
 * Returns 401 on missing or invalid key.
 */
function agentAuth(req, res, next) {
  const expectedKey = process.env.AGENT_INTERNAL_KEY;

  if (!expectedKey) {
    // Misconfiguration — fail closed
    console.error('[agent-auth] AGENT_INTERNAL_KEY is not set. All agent requests will be rejected.');
    return res.status(500).json({
      type: 'https://realsync.io/errors/configuration',
      title: 'Server Misconfiguration',
      status: 500,
      detail: 'Agent authentication is not configured.',
    });
  }

  const providedKey = req.headers['x-agent-key'];

  if (!providedKey) {
    return res.status(401).json({
      type: 'https://realsync.io/errors/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Missing X-Agent-Key header.',
    });
  }

  if (!timingSafeEqual(providedKey, expectedKey)) {
    return res.status(401).json({
      type: 'https://realsync.io/errors/unauthorized',
      title: 'Unauthorized',
      status: 401,
      detail: 'Invalid agent key.',
    });
  }

  next();
}

module.exports = { agentAuth, timingSafeEqual };
