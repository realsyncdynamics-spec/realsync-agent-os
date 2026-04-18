'use strict';

// db/index.js
// PostgreSQL Pool Setup + Query-Helpers
// Verwendet pg.Pool mit SSL-Support für Cloud-Deployments

const { Pool } = require('pg');

// ─── Pool-Konfiguration ───────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
  // Pool-Einstellungen
  max:             parseInt(process.env.PG_POOL_MAX || '20', 10),  // max. gleichzeitige Verbindungen
  idleTimeoutMillis: 30_000,                                        // Idle-Verbindungen nach 30s schließen
  connectionTimeoutMillis: 5_000,                                   // Verbindungs-Timeout: 5s
});

// ─── Pool-Events ──────────────────────────────────────────────────────────────
pool.on('connect', (client) => {
  // Row Level Security: Tenant-ID für jede neue Verbindung setzen
  // Wird bei Bedarf pro-Request überschrieben
  client.on('error', (err) => {
    console.error('[DB] Unexpected error on idle client', err.message);
  });
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected error on idle client', err.message);
});

// ─── Helper: query ────────────────────────────────────────────────────────────

/**
 * Führt eine parameterisierte SQL-Query aus.
 * Gibt den kompletten QueryResult zurück.
 *
 * @param {string} text    — SQL-Query mit $1, $2, ... Platzhaltern
 * @param {Array}  params  — Parameter-Array
 * @returns {Promise<import('pg').QueryResult>}
 *
 * @example
 * const result = await query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
 * const tenant = result.rows[0];
 */
async function query(text, params) {
  const start  = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;

  if (process.env.NODE_ENV !== 'production' && duration > 1000) {
    console.warn('[DB] Slow query detected', { text: text.slice(0, 100), duration: `${duration}ms`, rows: result.rowCount });
  }

  return result;
}

// ─── Helper: auditLog ─────────────────────────────────────────────────────────

/**
 * Schreibt einen Audit-Log-Eintrag direkt in die audit_logs Tabelle.
 * Pflicht nach EU AI Act Art. 12 für alle Hochrisiko-Operationen.
 *
 * @param {string}      tenantId    — UUID des Mandanten
 * @param {string|null} userId      — UUID des ausführenden Nutzers (null = System)
 * @param {string}      action      — Aktions-Bezeichner, z.B. "workflow.create"
 * @param {string}      entityType  — Entitäts-Typ, z.B. "workflow", "task"
 * @param {string|null} entityId    — UUID der betroffenen Entität
 * @param {object|null} before      — Zustand vor der Änderung (für UPDATE/DELETE)
 * @param {object|null} after       — Zustand nach der Änderung (für CREATE/UPDATE)
 * @param {string|null} ip          — IPv4/IPv6-Adresse des Initiators
 * @returns {Promise<string>}       — UUID des erstellten Log-Eintrags
 *
 * @example
 * await auditLog(
 *   tenantId, userId, 'workflow.delete', 'workflow', workflowId,
 *   { status: 'active' }, { status: 'completed' }, req.ip
 * );
 */
async function auditLog(tenantId, userId, action, entityType, entityId, before, after, ip) {
  try {
    const result = await pool.query(
      `INSERT INTO audit_logs
         (tenant_id, user_id, action, entity_type, entity_id, before, after, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        tenantId   || null,
        userId     || null,
        action,
        entityType,
        entityId   || null,
        before     ? JSON.stringify(before) : null,
        after      ? JSON.stringify(after)  : null,
        ip         || null,
      ]
    );
    return result.rows[0]?.id || null;
  } catch (err) {
    // Fallback: Console-Logging bei DB-Fehler
    console.error(
      `[AUDIT_FALLBACK] ${new Date().toISOString()} | ${action} | tenant=${tenantId} | ${entityType}:${entityId}`,
      { error: err.message }
    );
    return null;
  }
}

// ─── Helper: withTransaction ──────────────────────────────────────────────────

/**
 * Führt eine Funktion innerhalb einer DB-Transaktion aus.
 * Bei Fehler wird automatisch ROLLBACK ausgeführt.
 *
 * @param {Function} fn  — Async-Funktion die (client) erhält
 * @returns {Promise<*>}
 *
 * @example
 * await withTransaction(async (client) => {
 *   await client.query('UPDATE workflows SET status = $1 WHERE id = $2', ['active', id]);
 *   await client.query('INSERT INTO audit_logs ...', [...]);
 * });
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Helper: setTenantContext ─────────────────────────────────────────────────

/**
 * Setzt den PostgreSQL Row Level Security Kontext für eine Verbindung.
 * Muss vor Queries aufgerufen werden die RLS-Policies verwenden.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} tenantId
 */
async function setTenantContext(client, tenantId) {
  await client.query(`SET app.current_tenant_id = '${tenantId}'`);
}

// ─── Health-Check ─────────────────────────────────────────────────────────────

/**
 * Prüft ob die Datenbankverbindung funktioniert.
 * Verwendet in GET /health.
 *
 * @returns {Promise<{ status: 'ok'|'error', latency_ms: number }>}
 */
async function healthCheck() {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return { status: 'ok', latency_ms: Date.now() - start };
  } catch (err) {
    return { status: 'error', latency_ms: Date.now() - start, error: err.message };
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function close() {
  await pool.end();
  console.info('[DB] Pool closed');
}

module.exports = pool;
module.exports.query          = query;
module.exports.auditLog       = auditLog;
module.exports.withTransaction = withTransaction;
module.exports.setTenantContext = setTenantContext;
module.exports.healthCheck    = healthCheck;
module.exports.close          = close;
