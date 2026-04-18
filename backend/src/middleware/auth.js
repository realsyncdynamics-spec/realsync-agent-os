'use strict';

// middleware/auth.js
// JWT-Authentifizierung Middleware
// Liest Bearer Token aus Authorization Header, verifiziert JWT,
// setzt req.user und req.tenant_id

const crypto = require('crypto');

/**
 * Minimale JWT-Verifikation ohne externe Abhängigkeiten.
 * Für Produktion: jsonwebtoken-Paket empfohlen (npm install jsonwebtoken).
 *
 * @param {string} token  — Raw JWT string
 * @param {string} secret — JWT_SECRET from env
 * @returns {{ header: object, payload: object }}
 * @throws {Error} on invalid token
 */
function verifyJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT structure');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Verify signature
  const data      = `${headerB64}.${payloadB64}`;
  const expected  = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64url');

  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureB64))) {
    throw new Error('Invalid JWT signature');
  }

  // Decode payload
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid JWT payload');
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new Error('JWT expired');
  }
  if (payload.nbf && payload.nbf > now) {
    throw new Error('JWT not yet valid');
  }

  let header;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    header = {};
  }

  return { header, payload };
}

/**
 * Express Middleware: JWT-Authentifizierung
 *
 * Erwartet: Authorization: Bearer <token>
 * Setzt:    req.user       = { id, email, role, tenant_id, ... }
 *           req.tenant_id  = payload.tenant_id
 *
 * Antwortet mit 401 bei fehlendem oder ungültigem Token.
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];

  if (!authHeader) {
    return res.status(401).json({
      type:   'https://realsync.io/errors/unauthorized',
      title:  'Unauthorized',
      status: 401,
      detail: 'Authorization header is missing',
    });
  }

  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({
      type:   'https://realsync.io/errors/unauthorized',
      title:  'Unauthorized',
      status: 401,
      detail: 'Authorization header must use Bearer scheme',
    });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error('[AUTH] JWT_SECRET is not configured');
    return res.status(500).json({
      type:   'https://realsync.io/errors/internal-server-error',
      title:  'Internal Server Error',
      status: 500,
      detail: 'Authentication service misconfigured',
    });
  }

  let payload;
  try {
    // Try with jsonwebtoken if available, fall back to minimal implementation
    try {
      const jwt = require('jsonwebtoken');
      payload = jwt.verify(token, secret);
    } catch (requireErr) {
      if (requireErr.code === 'MODULE_NOT_FOUND') {
        // Fallback: minimal implementation
        const result = verifyJwt(token, secret);
        payload = result.payload;
      } else {
        throw requireErr;
      }
    }
  } catch (err) {
    return res.status(401).json({
      type:   'https://realsync.io/errors/unauthorized',
      title:  'Unauthorized',
      status: 401,
      detail: `Invalid or expired token: ${err.message}`,
    });
  }

  if (!payload.tenant_id) {
    return res.status(401).json({
      type:   'https://realsync.io/errors/unauthorized',
      title:  'Unauthorized',
      status: 401,
      detail: 'Token missing tenant_id claim',
    });
  }

  // User und Tenant-ID an Request anhängen
  req.user      = payload;
  req.tenant_id = payload.tenant_id;

  next();
}

/**
 * Optional: Role-based access control guard.
 * Verwendung: router.post('/admin', auth, requireRole('admin', 'owner'), handler)
 *
 * @param {...string} roles — Erlaubte Rollen
 * @returns {Function} Express-Middleware
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        type:   'https://realsync.io/errors/unauthorized',
        title:  'Unauthorized',
        status: 401,
        detail: 'Authentication required',
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        type:   'https://realsync.io/errors/forbidden',
        title:  'Forbidden',
        status: 403,
        detail: `Required role: ${roles.join(' or ')}. Your role: ${req.user.role}`,
      });
    }

    next();
  };
}

module.exports = { authMiddleware, requireRole };
