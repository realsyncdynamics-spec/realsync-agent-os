'use strict';

// routes/gateways.js
// Express Router für OpenClaw Gateway Management

const express  = require('express');
const crypto   = require('crypto');
const winston  = require('winston');
const pool     = require('../db');

const router = express.Router();

// ─── Logger ───────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

function problemDetail(res, status, title, detail) {
  return res.status(status).json({
    type:   `https://realsync.io/errors/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
  });
}

/**
 * Hash API-Key mit SHA-256 für sichere Speicherung.
 * In Produktion: argon2 oder bcrypt empfohlen.
 */
function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

async function writeAuditLog({ tenantId, userId, action, entityType, entityId, before, after, ip }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, before, after, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, userId || null, action, entityType, entityId || null,
       before ? JSON.stringify(before) : null,
       after  ? JSON.stringify(after)  : null,
       ip || null]
    );
  } catch (err) {
    logger.error('Audit log write failed', { error: err.message });
  }
}

// ─── POST /gateways/register ─────────────────────────────────────────────────
// Gateway registrieren
router.post('/register', async (req, res) => {
  const tenantId = req.tenant_id;
  const userId   = req.user?.id;
  const { name, host, port, api_key, tls_fingerprint, capabilities, tags } = req.body;

  if (!name || !host || !api_key) {
    return problemDetail(res, 400, 'Bad Request', 'name, host, and api_key are required');
  }

  const portNum = parseInt(port || '3000', 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return problemDetail(res, 400, 'Bad Request', 'port must be a valid port number (1-65535)');
  }

  try {
    const apiKeyHash = hashApiKey(api_key);

    const result = await pool.query(
      `INSERT INTO openclaw_gateways
         (tenant_id, name, host, port, api_key_hash, tls_fingerprint, capabilities, tags, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'offline')
       ON CONFLICT (tenant_id, host)
         DO UPDATE SET name = EXCLUDED.name, port = EXCLUDED.port,
                       api_key_hash = EXCLUDED.api_key_hash,
                       tls_fingerprint = EXCLUDED.tls_fingerprint,
                       capabilities = EXCLUDED.capabilities,
                       tags = EXCLUDED.tags, updated_at = NOW()
       RETURNING id, tenant_id, name, host, port, status, capabilities, tags, created_at, updated_at`,
      [
        tenantId, name, host, portNum, apiKeyHash,
        tls_fingerprint || null,
        JSON.stringify(capabilities || {}),
        tags || [],
      ]
    );
    const gateway = result.rows[0];

    await writeAuditLog({
      tenantId, userId, action: 'gateway.register',
      entityType: 'gateway', entityId: gateway.id,
      after: gateway, ip: req.ip,
    });

    logger.info('Gateway registered', { tenantId, gatewayId: gateway.id, host });
    return res.status(201).json({ data: gateway });
  } catch (err) {
    logger.error('POST /gateways/register failed', { error: err.message, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── POST /gateways/:id/heartbeat ────────────────────────────────────────────
// Heartbeat Update — aktualisiert last_heartbeat und status
router.post('/:id/heartbeat', async (req, res) => {
  const { id }   = req.params;
  const tenantId = req.tenant_id;
  const { version, capabilities } = req.body;

  try {
    const updates = ['status = \'online\'', 'last_heartbeat = NOW()', 'updated_at = NOW()'];
    const params  = [];

    if (version !== undefined) {
      params.push(version);
      updates.push(`version = $${params.length}`);
    }
    if (capabilities !== undefined) {
      params.push(JSON.stringify(capabilities));
      updates.push(`capabilities = $${params.length}`);
    }

    params.push(id, tenantId);

    const result = await pool.query(
      `UPDATE openclaw_gateways SET ${updates.join(', ')}
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
       RETURNING id, status, last_heartbeat, version`,
      params
    );

    if (result.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Gateway ${id} not found`);
    }

    return res.json({ data: result.rows[0] });
  } catch (err) {
    logger.error('POST /gateways/:id/heartbeat failed', { error: err.message, id, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── GET /gateways ────────────────────────────────────────────────────────────
// Liste aller Gateways des Tenants
router.get('/', async (req, res) => {
  const tenantId = req.tenant_id;
  const status   = req.query.status || null;

  try {
    let queryText = `
      SELECT id, tenant_id, name, host, port, status, last_heartbeat,
             capabilities, version, tags, created_at, updated_at
      FROM openclaw_gateways
      WHERE tenant_id = $1
    `;
    const params = [tenantId];

    if (status) {
      params.push(status);
      queryText += ` AND status = $${params.length}`;
    }

    queryText += ' ORDER BY created_at DESC';

    const result = await pool.query(queryText, params);
    return res.json({ data: result.rows });
  } catch (err) {
    logger.error('GET /gateways failed', { error: err.message, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── GET /gateways/:id ───────────────────────────────────────────────────────
// Gateway-Details
router.get('/:id', async (req, res) => {
  const { id }   = req.params;
  const tenantId = req.tenant_id;

  try {
    const result = await pool.query(
      `SELECT id, tenant_id, name, host, port, status, last_heartbeat,
              capabilities, tls_fingerprint, version, tags, created_at, updated_at
       FROM openclaw_gateways
       WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );

    if (result.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Gateway ${id} not found`);
    }

    return res.json({ data: result.rows[0] });
  } catch (err) {
    logger.error('GET /gateways/:id failed', { error: err.message, id, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── DELETE /gateways/:id ────────────────────────────────────────────────────
// Gateway deregistrieren
router.delete('/:id', async (req, res) => {
  const { id }   = req.params;
  const tenantId = req.tenant_id;
  const userId   = req.user?.id;

  try {
    const current = await pool.query(
      'SELECT * FROM openclaw_gateways WHERE id = $1 AND tenant_id = $2',
      [id, tenantId]
    );
    if (current.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Gateway ${id} not found`);
    }

    await pool.query('DELETE FROM openclaw_gateways WHERE id = $1', [id]);

    await writeAuditLog({
      tenantId, userId, action: 'gateway.deregister',
      entityType: 'gateway', entityId: id,
      before: { name: current.rows[0].name, host: current.rows[0].host },
      ip: req.ip,
    });

    logger.info('Gateway deregistered', { tenantId, gatewayId: id });
    return res.status(204).send();
  } catch (err) {
    logger.error('DELETE /gateways/:id failed', { error: err.message, id, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

module.exports = router;
