'use strict';

// middleware/audit.js
// EU AI Act Art. 12 — Audit-Logging-Middleware
// Loggt alle schreibenden Requests (POST/PATCH/DELETE/PUT) in audit_logs Tabelle.
// Unveränderliche Aufzeichnung für Konformitätsnachweise.

const pool = require('../db');

// HTTP-Methoden die als mutierende Aktionen protokolliert werden
const MUTABLE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Gibt den Entity-Typ anhand des URL-Pfades zurück.
 * Erlaubt strukturierte Abfragen im Audit-Log nach Entitäts-Typ.
 *
 * @param {string} path
 * @returns {string}
 */
function inferEntityType(path) {
  const segments = path.replace(/^\/api\//, '').split('/');
  const first    = segments[0] || 'unknown';

  const entityMap = {
    'workflows':  'workflow',
    'tasks':      'task',
    'gateways':   'gateway',
    'compliance': 'compliance_report',
    'users':      'user',
    'tenants':    'tenant',
    'webhooks':   'webhook',
  };

  return entityMap[first] || first;
}

/**
 * Versucht, die Entity-ID aus dem URL-Pfad zu extrahieren.
 * Gibt null zurück wenn keine UUID gefunden wurde.
 *
 * @param {string} path
 * @returns {string|null}
 */
function inferEntityId(path) {
  const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const match = path.match(UUID_REGEX);
  return match ? match[0] : null;
}

/**
 * Erstellt eine lesbare Action-Bezeichnung aus Methode + Pfad.
 * Format: "<entity_type>.<operation>"
 *
 * @param {string} method
 * @param {string} path
 * @returns {string}
 */
function buildAction(method, path) {
  const entityType = inferEntityType(path);
  const segments   = path.replace(/^\/api\//, '').split('/').filter(Boolean);

  // Spezifische Sub-Aktionen erkennen (z.B. /execute, /pause, /approve)
  const lastSegment = segments[segments.length - 1];
  const subActions  = ['execute', 'pause', 'resume', 'approve', 'register', 'heartbeat'];

  if (subActions.includes(lastSegment)) {
    return `${entityType}.${lastSegment}`;
  }

  const methodMap = {
    POST:   'create',
    PUT:    'update',
    PATCH:  'update',
    DELETE: 'delete',
  };

  return `${entityType}.${methodMap[method] || method.toLowerCase()}`;
}

/**
 * Schreibt Audit-Log-Eintrag asynchron (fire-and-forget mit Error-Handling).
 * Fehler beim Schreiben werden geloggt aber nicht an den Client weitergegeben,
 * um die User-Experience nicht zu beeinträchtigen.
 */
async function persistAuditLog({ tenantId, userId, action, entityType, entityId, ip, userAgent, requestBody }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs
         (tenant_id, user_id, action, entity_type, entity_id, after, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        tenantId     || null,
        userId       || null,
        action,
        entityType,
        entityId     || null,
        requestBody  ? JSON.stringify(sanitizeBody(requestBody)) : null,
        ip           || null,
        userAgent    || null,
      ]
    );
  } catch (err) {
    // Kritischer Fallback: Bei DB-Fehler auf stderr loggen
    // In Produktion: Fail-Safe zu lokalem WORM-Storage oder SIEM
    console.error(
      `[AUDIT_FALLBACK] ${new Date().toISOString()} | action=${action} | tenant=${tenantId} | entity=${entityType}:${entityId} | ip=${ip}`,
      { error: err.message }
    );
  }
}

/**
 * Entfernt sensible Felder aus dem Request-Body vor dem Audit-Log.
 * Verhindert, dass Passwörter, API-Keys etc. im Klartext gespeichert werden.
 *
 * @param {object} body
 * @returns {object}
 */
function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body;

  const SENSITIVE_FIELDS = [
    'password', 'password_hash', 'api_key', 'apiKey', 'api_key_hash',
    'secret', 'token', 'access_token', 'refresh_token',
    'mfa_secret', 'stripe_key', 'webhook_secret',
  ];

  const sanitized = { ...body };
  for (const field of SENSITIVE_FIELDS) {
    if (sanitized[field] !== undefined) {
      sanitized[field] = '[REDACTED]';
    }
  }

  return sanitized;
}

/**
 * Express Middleware: Audit-Logging für mutierende Requests.
 *
 * Loggt automatisch alle POST/PATCH/PUT/DELETE Requests mit:
 * - tenant_id (aus req.tenant_id, gesetzt von Auth-Middleware)
 * - user_id   (aus req.user.id)
 * - action    (abgeleitet aus Methode + Pfad)
 * - entity_type und entity_id (aus URL-Parsing)
 * - IP-Adresse
 * - User-Agent
 *
 * Muss NACH der Auth-Middleware eingebunden werden.
 */
function auditMiddleware(req, res, next) {
  if (!MUTABLE_METHODS.has(req.method)) {
    return next(); // Lesende Requests nicht protokollieren
  }

  const tenantId  = req.tenant_id || null;
  const userId    = req.user?.id  || null;
  const action    = buildAction(req.method, req.path);
  const entityType = inferEntityType(req.path);
  const entityId   = inferEntityId(req.path);
  const ip         = req.ip || req.connection?.remoteAddress || null;
  const userAgent  = req.get('User-Agent') || null;

  // Request-Body für Audit (nach Response, damit Fehler-Requests auch geloggt werden)
  const requestBody = req.body;

  // Antwort abfangen um Response-Status zu loggen (optional)
  const originalEnd = res.end.bind(res);
  res.end = function(chunk, encoding) {
    // Audit-Log asynchron schreiben (nach Response-Ende)
    setImmediate(() => {
      persistAuditLog({
        tenantId,
        userId,
        action,
        entityType,
        entityId,
        ip,
        userAgent,
        requestBody,
      });
    });

    return originalEnd(chunk, encoding);
  };

  next();
}

module.exports = { auditMiddleware, sanitizeBody, buildAction, inferEntityType };
