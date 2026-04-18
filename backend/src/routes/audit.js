'use strict';

/**
 * RealSyncDynamics Agent-OS — Audit Log Query Routes
 *
 * Provides paginated, filtered, exportable access to the audit_logs table.
 * All queries are fully parameterized — no string interpolation.
 *
 * audit_logs schema reference:
 *   id          UUID PRIMARY KEY DEFAULT gen_random_uuid()
 *   tenant_id   UUID NOT NULL REFERENCES tenants(id)
 *   user_id     UUID REFERENCES users(id)
 *   action      TEXT NOT NULL
 *   resource    TEXT
 *   resource_id UUID
 *   details     JSONB DEFAULT '{}'
 *   ip_address  TEXT
 *   user_agent  TEXT
 *   status      TEXT
 *   created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
 */

const express = require('express');
const pool = require('../db');

const router = express.Router();

// ─── constants ────────────────────────────────────────────────────────────────

const MAX_PAGE_LIMIT   = 100;
const MAX_EXPORT_ROWS  = 10_000;
const EXPORT_BATCH_SZ  = 500;   // cursor-based fetch batch size for streaming

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * RFC 9457 Problem Details response.
 */
function problemJson(res, status, title, detail, extra = {}) {
  return res.status(status).type('application/problem+json').json({
    type: `https://realsync.io/problems/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
    instance: res.req.originalUrl,
    ...extra,
  });
}

/**
 * Validate an ISO-8601 date string.
 * @param {string} value
 * @returns {boolean}
 */
function isValidISODate(value) {
  if (typeof value !== 'string') return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

/**
 * Build a parameterized WHERE clause from common audit filter params.
 * Returns { conditions: string[], params: any[], nextIdx: number }
 *
 * @param {object} query   req.query
 * @param {string} tenantId
 * @param {number} startIdx  starting $N index (default 1 consumed by tenant_id)
 */
function buildAuditFilters(query, tenantId, startIdx = 2) {
  const conditions = ['al.tenant_id = $1'];
  const params = [tenantId];
  let idx = startIdx;

  if (query.action) {
    conditions.push(`al.action = $${idx++}`);
    params.push(query.action);
  }

  if (query.user_id) {
    conditions.push(`al.user_id = $${idx++}`);
    params.push(query.user_id);
  }

  if (query.resource) {
    conditions.push(`al.resource = $${idx++}`);
    params.push(query.resource);
  }

  if (query.status) {
    conditions.push(`al.status = $${idx++}`);
    params.push(query.status);
  }

  if (query.from) {
    if (!isValidISODate(query.from)) {
      return { error: "'from' must be a valid ISO-8601 date." };
    }
    conditions.push(`al.created_at >= $${idx++}`);
    params.push(new Date(query.from));
  }

  if (query.to) {
    if (!isValidISODate(query.to)) {
      return { error: "'to' must be a valid ISO-8601 date." };
    }
    conditions.push(`al.created_at <= $${idx++}`);
    params.push(new Date(query.to));
  }

  return { conditions, params, nextIdx: idx };
}

// ─── GET /api/audit — paginated audit log ────────────────────────────────────

router.get('/', async (req, res) => {
  const { tenant_id: tenantId } = req.user;

  // Pagination
  const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;

  const filterResult = buildAuditFilters(req.query, tenantId);
  if (filterResult.error) {
    return problemJson(res, 400, 'Invalid Parameter', filterResult.error);
  }

  const { conditions, params, nextIdx } = filterResult;
  const where = conditions.join(' AND ');

  const dataSql = `
    SELECT
      al.id, al.action, al.resource, al.resource_id,
      al.details, al.ip_address, al.user_agent,
      al.status, al.created_at,
      al.user_id, u.email AS user_email, u.name AS user_name
    FROM audit_logs al
    LEFT JOIN users u ON u.id = al.user_id
    WHERE ${where}
    ORDER BY al.created_at DESC
    LIMIT $${nextIdx} OFFSET $${nextIdx + 1}
  `;
  const dataParams = [...params, limit, offset];

  const countSql = `SELECT COUNT(*) AS total FROM audit_logs al WHERE ${where}`;

  try {
    const [dataResult, countResult] = await Promise.all([
      pool.query(dataSql, dataParams),
      pool.query(countSql, params),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return res.json({
      data: dataResult.rows,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
        has_next: offset + limit < total,
        has_prev: page > 1,
      },
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'audit_list_error', tenantId, error: err.message }));
    return problemJson(res, 500, 'Internal Server Error', 'Failed to retrieve audit logs.');
  }
});

// ─── GET /api/audit/export — NDJSON streaming export (admin only) ─────────────
// NOTE: declared before /stats so that both fixed paths resolve before /:id
// (this file has no /:id route, but keeping the pattern consistent).

router.get('/export', async (req, res) => {
  const { tenant_id: tenantId, role } = req.user;

  if (role !== 'admin') {
    return problemJson(res, 403, 'Forbidden', 'Audit log export requires admin role.');
  }

  const filterResult = buildAuditFilters(req.query, tenantId);
  if (filterResult.error) {
    return problemJson(res, 400, 'Invalid Parameter', filterResult.error);
  }

  const { conditions, params, nextIdx } = filterResult;
  const where = conditions.join(' AND ');

  // Count check — refuse if > MAX_EXPORT_ROWS
  const countSql = `SELECT COUNT(*) AS total FROM audit_logs al WHERE ${where}`;
  let total;
  try {
    const countResult = await pool.query(countSql, params);
    total = parseInt(countResult.rows[0].total, 10);
  } catch (err) {
    console.error(JSON.stringify({ event: 'audit_export_count_error', tenantId, error: err.message }));
    return problemJson(res, 500, 'Internal Server Error', 'Failed to prepare export.');
  }

  if (total > MAX_EXPORT_ROWS) {
    return problemJson(
      res, 422, 'Unprocessable Entity',
      `Export would return ${total} rows which exceeds the maximum of ${MAX_EXPORT_ROWS}. Narrow your filters.`,
      { row_count: total, max_rows: MAX_EXPORT_ROWS }
    );
  }

  // Stream NDJSON using cursor-based pagination (keyset on created_at + id)
  // to avoid OFFSET cost on large tables.
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Content-Disposition', `attachment; filename="audit-export-${Date.now()}.ndjson"`);
  res.setHeader('Transfer-Encoding', 'chunked');

  // Cursor state: start from the oldest record matching filters
  let lastCreatedAt = null;
  let lastId        = null;
  let rowsWritten   = 0;
  let hasMore       = true;

  // Build the base WHERE from filters; cursor condition is appended dynamically.
  // We re-parameterise per batch so we know the cursor param indices.
  const baseConditions = [...conditions];   // clone
  const baseParams     = [...params];       // clone

  try {
    while (hasMore && rowsWritten < MAX_EXPORT_ROWS) {
      const batchParams = [...baseParams];
      let batchIdx = nextIdx;
      const batchConditions = [...baseConditions];

      if (lastCreatedAt !== null && lastId !== null) {
        // Keyset: (created_at, id) > (lastCreatedAt, lastId)  ORDER BY ASC
        batchConditions.push(
          `(al.created_at, al.id) > ($${batchIdx}, $${batchIdx + 1})`
        );
        batchParams.push(lastCreatedAt, lastId);
        batchIdx += 2;
      }

      const batchSql = `
        SELECT
          al.id, al.tenant_id, al.user_id, al.action,
          al.resource, al.resource_id, al.details,
          al.ip_address, al.user_agent, al.status, al.created_at
        FROM audit_logs al
        WHERE ${batchConditions.join(' AND ')}
        ORDER BY al.created_at ASC, al.id ASC
        LIMIT $${batchIdx}
      `;
      batchParams.push(EXPORT_BATCH_SZ);

      const batchResult = await pool.query(batchSql, batchParams);

      if (batchResult.rowCount === 0) {
        hasMore = false;
        break;
      }

      for (const row of batchResult.rows) {
        res.write(JSON.stringify(row) + '\n');
        rowsWritten++;
        lastCreatedAt = row.created_at;
        lastId        = row.id;
      }

      hasMore = batchResult.rowCount === EXPORT_BATCH_SZ && rowsWritten < MAX_EXPORT_ROWS;
    }

    res.end();
    console.log(JSON.stringify({
      event: 'audit_export_complete',
      tenantId,
      rowsWritten,
    }));
  } catch (err) {
    console.error(JSON.stringify({ event: 'audit_export_stream_error', tenantId, error: err.message }));
    // Headers already sent — can only end the stream
    if (!res.writableEnded) res.end();
  }
});

// ─── GET /api/audit/stats — aggregate counts ──────────────────────────────────

router.get('/stats', async (req, res) => {
  const { tenant_id: tenantId } = req.user;

  // by_action
  const byActionSql = `
    SELECT action, COUNT(*) AS count
    FROM audit_logs
    WHERE tenant_id = $1
      AND created_at >= NOW() - INTERVAL '30 days'
    GROUP BY action
    ORDER BY count DESC
  `;

  // by_user (top contributors, last 30 days)
  const byUserSql = `
    SELECT al.user_id, u.email, COUNT(*) AS count
    FROM audit_logs al
    LEFT JOIN users u ON u.id = al.user_id
    WHERE al.tenant_id = $1
      AND al.created_at >= NOW() - INTERVAL '30 days'
    GROUP BY al.user_id, u.email
    ORDER BY count DESC
    LIMIT 50
  `;

  // by_day (daily totals, last 30 days)
  const byDaySql = `
    SELECT
      DATE_TRUNC('day', created_at)::DATE AS date,
      COUNT(*) AS count
    FROM audit_logs
    WHERE tenant_id = $1
      AND created_at >= NOW() - INTERVAL '30 days'
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  try {
    const [byActionResult, byUserResult, byDayResult] = await Promise.all([
      pool.query(byActionSql, [tenantId]),
      pool.query(byUserSql,   [tenantId]),
      pool.query(byDaySql,    [tenantId]),
    ]);

    return res.json({
      by_action: byActionResult.rows.map((r) => ({
        action: r.action,
        count:  parseInt(r.count, 10),
      })),
      by_user: byUserResult.rows.map((r) => ({
        user_id: r.user_id,
        email:   r.email,
        count:   parseInt(r.count, 10),
      })),
      by_day: byDayResult.rows.map((r) => ({
        date:  r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date),
        count: parseInt(r.count, 10),
      })),
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'audit_stats_error', tenantId, error: err.message }));
    return problemJson(res, 500, 'Internal Server Error', 'Failed to retrieve audit stats.');
  }
});

module.exports = router;
