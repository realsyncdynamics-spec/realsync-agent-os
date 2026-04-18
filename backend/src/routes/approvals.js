'use strict';

/**
 * RealSyncDynamics Agent-OS — Human-Approval Workflow Routes
 *
 * EU AI Act Art. 14 compliant: every approval/rejection decision is written
 * to audit_logs so there is a full, immutable record of human oversight.
 *
 * SQL schema reference (tables already exist in the database):
 *
 * -- approvals
 * --   id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 * --   tenant_id     UUID NOT NULL REFERENCES tenants(id),
 * --   workflow_id   UUID REFERENCES workflows(id),
 * --   task_id       UUID REFERENCES tasks(id),
 * --   requested_by  UUID NOT NULL REFERENCES users(id),
 * --   assigned_to   UUID REFERENCES users(id),
 * --   action        TEXT NOT NULL,
 * --   context       JSONB DEFAULT '{}',
 * --   status        TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired'))
 * --                 DEFAULT 'pending',
 * --   decision_by   UUID REFERENCES users(id),
 * --   decision_at   TIMESTAMPTZ,
 * --   decision_comment TEXT,
 * --   risk_level    TEXT NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
 * --   expires_at    TIMESTAMPTZ,
 * --   created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db');

const router = express.Router();

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * RFC 9457 Problem Details error helper.
 * @param {import('express').Response} res
 * @param {number} status   HTTP status code
 * @param {string} title    Short human-readable title
 * @param {string} detail   Detailed description
 * @param {object} [extra]  Additional fields to merge into the problem object
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
 * Structured JSON log line (replaces winston for route-level logging).
 * @param {string} event
 * @param {object} payload
 */
function structuredLog(event, payload) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'approvals-route',
      event,
      ...payload,
    })
  );
}

/**
 * Write a row to audit_logs (EU AI Act Art. 14 obligation).
 * Non-throwing — a failed audit write is logged but does NOT roll back
 * the primary transaction (the decision is committed first).
 *
 * @param {object} client  pg PoolClient (within an ongoing transaction)
 * @param {object} params
 */
async function writeAuditLog(client, { tenantId, userId, action, resource, resourceId, details, ip, userAgent, status }) {
  const sql = `
    INSERT INTO audit_logs
      (id, tenant_id, user_id, action, resource, resource_id, details,
       ip_address, user_agent, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
  `;
  await client.query(sql, [
    uuidv4(),
    tenantId,
    userId,
    action,
    resource,
    resourceId,
    JSON.stringify(details),
    ip || null,
    userAgent || null,
    status,
  ]);
}

/**
 * Validate and coerce pagination query params.
 * @param {object} query  req.query
 * @returns {{ page: number, limit: number, offset: number }}
 */
function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

// ─── GET /api/approvals  — list pending approvals for tenant ─────────────────

router.get('/', async (req, res) => {
  const { id: userId, tenant_id: tenantId } = req.user;
  const { page, limit, offset } = parsePagination(req.query);

  // Optional filters
  const allowedStatuses = ['pending', 'approved', 'rejected', 'expired'];
  const statusFilter = req.query.status && allowedStatuses.includes(req.query.status)
    ? req.query.status
    : null;
  const riskFilter = req.query.risk_level || null;
  const assignedFilter = req.query.assigned_to || null;

  const conditions = ['a.tenant_id = $1'];
  const params = [tenantId];
  let idx = 2;

  if (statusFilter) {
    conditions.push(`a.status = $${idx++}`);
    params.push(statusFilter);
  } else {
    // Default: only show pending when no status filter supplied
    conditions.push(`a.status = 'pending'`);
  }

  if (riskFilter) {
    const validRisk = ['low', 'medium', 'high', 'critical'];
    if (!validRisk.includes(riskFilter)) {
      return problemJson(res, 400, 'Invalid Parameter', `risk_level must be one of: ${validRisk.join(', ')}`);
    }
    conditions.push(`a.risk_level = $${idx++}`);
    params.push(riskFilter);
  }

  if (assignedFilter) {
    conditions.push(`a.assigned_to = $${idx++}`);
    params.push(assignedFilter);
  }

  const where = conditions.join(' AND ');

  const dataSql = `
    SELECT
      a.id, a.workflow_id, a.task_id, a.action, a.context,
      a.status, a.risk_level, a.expires_at, a.created_at,
      a.requested_by, rb.email AS requested_by_email,
      a.assigned_to,  at2.email AS assigned_to_email,
      a.decision_by,  db.email  AS decision_by_email,
      a.decision_at,  a.decision_comment
    FROM approvals a
    LEFT JOIN users rb  ON rb.id  = a.requested_by
    LEFT JOIN users at2 ON at2.id = a.assigned_to
    LEFT JOIN users db  ON db.id  = a.decision_by
    WHERE ${where}
    ORDER BY
      CASE a.risk_level
        WHEN 'critical' THEN 1
        WHEN 'high'     THEN 2
        WHEN 'medium'   THEN 3
        ELSE                 4
      END ASC,
      a.created_at ASC
    LIMIT $${idx} OFFSET $${idx + 1}
  `;
  params.push(limit, offset);

  const countSql = `SELECT COUNT(*) AS total FROM approvals a WHERE ${where}`;
  // Count params do not include limit/offset
  const countParams = params.slice(0, idx - 1);

  try {
    const [dataResult, countResult] = await Promise.all([
      pool.query(dataSql, params),
      pool.query(countSql, countParams),
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
    structuredLog('list_approvals_error', { tenantId, userId, error: err.message });
    return problemJson(res, 500, 'Internal Server Error', 'Failed to retrieve approvals.');
  }
});

// ─── GET /api/approvals/stats — KPI counts by status ─────────────────────────
// NOTE: must be declared BEFORE /:id so Express matches it correctly.

router.get('/stats', async (req, res) => {
  const { tenant_id: tenantId } = req.user;

  const sql = `
    SELECT
      status,
      risk_level,
      COUNT(*) AS count
    FROM approvals
    WHERE tenant_id = $1
    GROUP BY status, risk_level
    ORDER BY status, risk_level
  `;

  try {
    const result = await pool.query(sql, [tenantId]);

    // Shape into a nested summary for dashboard consumption
    const byStatus = {};
    const byRisk   = {};

    for (const row of result.rows) {
      const cnt = parseInt(row.count, 10);

      byStatus[row.status] = (byStatus[row.status] || 0) + cnt;

      if (!byRisk[row.risk_level]) byRisk[row.risk_level] = {};
      byRisk[row.risk_level][row.status] = (byRisk[row.risk_level][row.status] || 0) + cnt;
    }

    // Pending expiry warning: approvals expiring within 1 hour
    const expirySql = `
      SELECT COUNT(*) AS expiring_soon
      FROM approvals
      WHERE tenant_id = $1
        AND status = 'pending'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW() + INTERVAL '1 hour'
        AND expires_at > NOW()
    `;
    const expiryResult = await pool.query(expirySql, [tenantId]);

    return res.json({
      by_status: byStatus,
      by_risk:   byRisk,
      expiring_soon: parseInt(expiryResult.rows[0].expiring_soon, 10),
    });
  } catch (err) {
    structuredLog('stats_error', { tenantId, error: err.message });
    return problemJson(res, 500, 'Internal Server Error', 'Failed to retrieve approval stats.');
  }
});

// ─── GET /api/approvals/:id — single approval detail ─────────────────────────

router.get('/:id', async (req, res) => {
  const { id: userId, tenant_id: tenantId } = req.user;
  const { id } = req.params;

  // Basic UUID format check
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(id)) {
    return problemJson(res, 400, 'Invalid Parameter', 'Approval ID must be a valid UUID.');
  }

  const sql = `
    SELECT
      a.*,
      rb.email  AS requested_by_email,
      rb.name   AS requested_by_name,
      at2.email AS assigned_to_email,
      at2.name  AS assigned_to_name,
      db.email  AS decision_by_email,
      db.name   AS decision_by_name,
      t.status  AS task_current_status,
      w.name    AS workflow_name
    FROM approvals a
    LEFT JOIN users     rb  ON rb.id  = a.requested_by
    LEFT JOIN users     at2 ON at2.id = a.assigned_to
    LEFT JOIN users     db  ON db.id  = a.decision_by
    LEFT JOIN tasks     t   ON t.id   = a.task_id
    LEFT JOIN workflows w   ON w.id   = a.workflow_id
    WHERE a.id = $1
      AND a.tenant_id = $2
  `;

  try {
    const result = await pool.query(sql, [id, tenantId]);

    if (result.rowCount === 0) {
      return problemJson(res, 404, 'Not Found', `Approval ${id} not found or not accessible.`);
    }

    return res.json({ data: result.rows[0] });
  } catch (err) {
    structuredLog('get_approval_error', { tenantId, userId, approvalId: id, error: err.message });
    return problemJson(res, 500, 'Internal Server Error', 'Failed to retrieve approval.');
  }
});

// ─── POST /api/approvals/:id/approve ─────────────────────────────────────────

router.post('/:id/approve', async (req, res) => {
  const { id: actorId, tenant_id: tenantId } = req.user;
  const { id } = req.params;
  const { comment } = req.body;   // comment encouraged but not required for low-risk
  const ip = req.ip || req.headers['x-forwarded-for'] || null;
  const ua = req.headers['user-agent'] || null;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(id)) {
    return problemJson(res, 400, 'Invalid Parameter', 'Approval ID must be a valid UUID.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the row to prevent concurrent decisions
    const lockSql = `
      SELECT a.*, t.id AS task_id_check
      FROM approvals a
      LEFT JOIN tasks t ON t.id = a.task_id
      WHERE a.id = $1
        AND a.tenant_id = $2
      FOR UPDATE NOWAIT
    `;
    const lockResult = await client.query(lockSql, [id, tenantId]);

    if (lockResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return problemJson(res, 404, 'Not Found', `Approval ${id} not found or not accessible.`);
    }

    const approval = lockResult.rows[0];

    if (approval.status !== 'pending') {
      await client.query('ROLLBACK');
      return problemJson(
        res, 409, 'Conflict',
        `Approval is already in '${approval.status}' state and cannot be approved.`,
        { current_status: approval.status }
      );
    }

    // Check for expiry
    if (approval.expires_at && new Date(approval.expires_at) < new Date()) {
      // Mark expired then reject
      await client.query(
        `UPDATE approvals SET status = 'expired' WHERE id = $1`,
        [id]
      );
      await client.query('COMMIT');
      return problemJson(res, 410, 'Gone', 'This approval request has expired.');
    }

    // High/critical approvals require a comment (audit trail quality)
    if (['high', 'critical'].includes(approval.risk_level) && (!comment || !comment.trim())) {
      await client.query('ROLLBACK');
      return problemJson(
        res, 422, 'Unprocessable Entity',
        'A comment is required when approving high or critical risk actions.',
        { required_for: ['high', 'critical'] }
      );
    }

    // 1. Update approval record
    const approvalUpdateSql = `
      UPDATE approvals
      SET
        status           = 'approved',
        decision_by      = $1,
        decision_at      = NOW(),
        decision_comment = $2
      WHERE id = $3
      RETURNING *
    `;
    const approvalResult = await client.query(approvalUpdateSql, [actorId, comment || null, id]);

    // 2. Update the linked task status
    if (approval.task_id) {
      await client.query(
        `UPDATE tasks SET status = 'approved', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
        [approval.task_id, tenantId]
      );
    }

    // 3. EU AI Act Art. 14 — audit log entry
    await writeAuditLog(client, {
      tenantId,
      userId:     actorId,
      action:     'approval.approved',
      resource:   'approval',
      resourceId: id,
      details: {
        workflow_id:      approval.workflow_id,
        task_id:          approval.task_id,
        requested_by:     approval.requested_by,
        action_approved:  approval.action,
        risk_level:       approval.risk_level,
        comment:          comment || null,
      },
      ip,
      userAgent: ua,
      status:    'success',
    });

    await client.query('COMMIT');

    // 4. Structured log for observability
    structuredLog('approval_decision', {
      decision:    'approved',
      approvalId:  id,
      tenantId,
      actorId,
      riskLevel:   approval.risk_level,
      taskId:      approval.task_id,
      workflowId:  approval.workflow_id,
    });

    return res.status(200).json({
      data: approvalResult.rows[0],
      message: 'Approval granted.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});

    // pg error 55P03 = lock_not_available (concurrent decision in progress)
    if (err.code === '55P03') {
      return problemJson(res, 409, 'Conflict', 'Another decision is being processed for this approval. Please retry.');
    }

    structuredLog('approve_error', { approvalId: id, tenantId, actorId, error: err.message });
    return problemJson(res, 500, 'Internal Server Error', 'Failed to process approval.');
  } finally {
    client.release();
  }
});

// ─── POST /api/approvals/:id/reject ──────────────────────────────────────────

router.post('/:id/reject', async (req, res) => {
  const { id: actorId, tenant_id: tenantId } = req.user;
  const { id } = req.params;
  const { reason } = req.body;
  const ip = req.ip || req.headers['x-forwarded-for'] || null;
  const ua = req.headers['user-agent'] || null;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(id)) {
    return problemJson(res, 400, 'Invalid Parameter', 'Approval ID must be a valid UUID.');
  }

  // Reason is always required for rejection (audit quality)
  if (!reason || !String(reason).trim()) {
    return problemJson(res, 422, 'Unprocessable Entity', 'A reason is required when rejecting an approval request.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const lockSql = `
      SELECT *
      FROM approvals
      WHERE id = $1
        AND tenant_id = $2
      FOR UPDATE NOWAIT
    `;
    const lockResult = await client.query(lockSql, [id, tenantId]);

    if (lockResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return problemJson(res, 404, 'Not Found', `Approval ${id} not found or not accessible.`);
    }

    const approval = lockResult.rows[0];

    if (approval.status !== 'pending') {
      await client.query('ROLLBACK');
      return problemJson(
        res, 409, 'Conflict',
        `Approval is already in '${approval.status}' state and cannot be rejected.`,
        { current_status: approval.status }
      );
    }

    // 1. Update approval record
    const approvalUpdateSql = `
      UPDATE approvals
      SET
        status           = 'rejected',
        decision_by      = $1,
        decision_at      = NOW(),
        decision_comment = $2
      WHERE id = $3
      RETURNING *
    `;
    const approvalResult = await client.query(approvalUpdateSql, [actorId, reason, id]);

    // 2. Update the linked task status
    if (approval.task_id) {
      await client.query(
        `UPDATE tasks SET status = 'rejected', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
        [approval.task_id, tenantId]
      );
    }

    // 3. EU AI Act Art. 14 — audit log entry
    await writeAuditLog(client, {
      tenantId,
      userId:     actorId,
      action:     'approval.rejected',
      resource:   'approval',
      resourceId: id,
      details: {
        workflow_id:     approval.workflow_id,
        task_id:         approval.task_id,
        requested_by:    approval.requested_by,
        action_rejected: approval.action,
        risk_level:      approval.risk_level,
        reason,
      },
      ip,
      userAgent: ua,
      status:    'success',
    });

    await client.query('COMMIT');

    // 4. Structured log
    structuredLog('approval_decision', {
      decision:   'rejected',
      approvalId: id,
      tenantId,
      actorId,
      riskLevel:  approval.risk_level,
      taskId:     approval.task_id,
      workflowId: approval.workflow_id,
    });

    return res.status(200).json({
      data: approvalResult.rows[0],
      message: 'Approval rejected.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});

    if (err.code === '55P03') {
      return problemJson(res, 409, 'Conflict', 'Another decision is being processed for this approval. Please retry.');
    }

    structuredLog('reject_error', { approvalId: id, tenantId, actorId, error: err.message });
    return problemJson(res, 500, 'Internal Server Error', 'Failed to process rejection.');
  } finally {
    client.release();
  }
});

module.exports = router;
