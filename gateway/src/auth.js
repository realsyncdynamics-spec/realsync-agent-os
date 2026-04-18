'use strict';

/**
 * OpenClaw Gateway — Auth Middleware
 * API-Key validation using SHA-256 hash comparison with timing-safe equality.
 */

const crypto = require('crypto');
const logger = require('./logger');

/**
 * Hashes a plain-text key with SHA-256 and returns the hex digest.
 * @param {string} key
 * @returns {string}
 */
function hashKey(key) {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Express middleware that validates the X-API-Key header.
 * The /health endpoint is excluded from auth checks.
 *
 * Configuration:
 *   GATEWAY_API_KEY — the raw (plain-text) secret key; compared after hashing.
 *
 * Security notes:
 *   - Uses crypto.timingSafeEqual to prevent timing-oracle attacks.
 *   - Missing or empty GATEWAY_API_KEY at boot is treated as a fatal misconfiguration.
 */
function authMiddleware(req, res, next) {
  // Public routes — no auth required
  if (req.path === '/health') {
    return next();
  }

  const rawEnvKey = process.env.GATEWAY_API_KEY;

  if (!rawEnvKey || rawEnvKey.trim() === '') {
    logger.error('GATEWAY_API_KEY is not configured — refusing all authenticated requests');
    return res.status(503).json({
      error: 'Service misconfigured',
      message: 'Gateway API key is not set. Set GATEWAY_API_KEY in your environment.',
    });
  }

  const providedKey = req.headers['x-api-key'];

  if (!providedKey) {
    logger.warn(`Auth: missing X-API-Key header [${req.method} ${req.path}] from ${req.ip}`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing X-API-Key header.',
    });
  }

  // Hash both sides so we never store or compare plaintext
  const expectedHash = Buffer.from(hashKey(rawEnvKey), 'hex');
  const providedHash = Buffer.from(hashKey(providedKey), 'hex');

  // Lengths must match for timingSafeEqual
  if (
    expectedHash.length !== providedHash.length ||
    !crypto.timingSafeEqual(expectedHash, providedHash)
  ) {
    logger.warn(`Auth: invalid API key [${req.method} ${req.path}] from ${req.ip}`);
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key.',
    });
  }

  logger.debug(`Auth: accepted [${req.method} ${req.path}] from ${req.ip}`);
  next();
}

module.exports = { authMiddleware, hashKey };
