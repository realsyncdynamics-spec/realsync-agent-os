'use strict';

// routes/compliance.js
// Express Router für EU-AI-Act Compliance-Reports
// Rechtsgrundlage: Verordnung (EU) 2024/1689, Art. 12, 17

const express = require('express');
const winston = require('winston');
const pool    = require('../db');

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

async function writeAuditLog({ tenantId, userId, action, entityType, entityId, after, ip }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, after, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, userId || null, action, entityType, entityId || null,
       after ? JSON.stringify(after) : null, ip || null]
    );
  } catch (err) {
    logger.error('Audit log write failed', { error: err.message });
  }
}

// ─── GET /compliance/reports ──────────────────────────────────────────────────
// Reports abrufen (paginiert, filterbar nach risk_level und report_type)
router.get('/reports', async (req, res) => {
  const tenantId   = req.tenant_id;
  const page       = Math.max(1, parseInt(req.query.page       || '1',  10));
  const limit      = Math.min(100, parseInt(req.query.limit    || '20', 10));
  const offset     = (page - 1) * limit;
  const riskLevel  = req.query.risk_level  || null;
  const reportType = req.query.report_type || null;

  try {
    let queryText = `
      SELECT cr.*,
             w.title AS workflow_title,
             u.display_name AS approved_by_name
      FROM compliance_reports cr
      LEFT JOIN workflows w ON w.id = cr.workflow_id
      LEFT JOIN users u ON u.id = cr.approved_by
      WHERE cr.tenant_id = $1
    `;
    const params = [tenantId];

    if (riskLevel) {
      params.push(riskLevel);
      queryText += ` AND cr.risk_level = $${params.length}`;
    }
    if (reportType) {
      params.push(reportType);
      queryText += ` AND cr.report_type = $${params.length}`;
    }

    queryText += ` ORDER BY cr.generated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const [rows, countResult] = await Promise.all([
      pool.query(queryText, params),
      pool.query(
        `SELECT COUNT(*) FROM compliance_reports WHERE tenant_id = $1
         ${riskLevel ? ' AND risk_level = $2' : ''}${reportType ? ` AND report_type = $${riskLevel ? 3 : 2}` : ''}`,
        [tenantId, ...(riskLevel ? [riskLevel] : []), ...(reportType ? [reportType] : [])]
      ),
    ]);

    return res.json({
      data: rows.rows,
      meta: {
        total: parseInt(countResult.rows[0].count, 10),
        page,
        limit,
        pages: Math.ceil(parseInt(countResult.rows[0].count, 10) / limit),
      },
    });
  } catch (err) {
    logger.error('GET /compliance/reports failed', { error: err.message, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── POST /compliance/reports ─────────────────────────────────────────────────
// Report generieren (durch Compliance-Agenten oder manuell)
router.post('/reports', async (req, res) => {
  const tenantId = req.tenant_id;
  const userId   = req.user?.id;
  const {
    workflow_id,
    report_type = 'eu_ai_act',
    risk_level,
    findings,
    recommendations,
    expires_at,
  } = req.body;

  if (!risk_level) {
    return problemDetail(res, 400, 'Bad Request', 'risk_level is required (minimal|limited|high)');
  }

  const validRiskLevels = ['minimal', 'limited', 'high'];
  if (!validRiskLevels.includes(risk_level)) {
    return problemDetail(res, 400, 'Bad Request', `risk_level must be one of: ${validRiskLevels.join(', ')}`);
  }

  // Optional: workflow_id validieren
  if (workflow_id) {
    const wfCheck = await pool.query(
      'SELECT id FROM workflows WHERE id = $1 AND tenant_id = $2',
      [workflow_id, tenantId]
    ).catch(() => ({ rows: [] }));
    if (wfCheck.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Workflow ${workflow_id} not found`);
    }
  }

  try {
    const result = await pool.query(
      `INSERT INTO compliance_reports
         (tenant_id, workflow_id, report_type, risk_level, findings, recommendations, generated_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'compliance', $7)
       RETURNING *`,
      [
        tenantId,
        workflow_id || null,
        report_type,
        risk_level,
        JSON.stringify(findings || {}),
        JSON.stringify(recommendations || []),
        expires_at || null,
      ]
    );
    const report = result.rows[0];

    await writeAuditLog({
      tenantId, userId, action: 'compliance.report.create',
      entityType: 'compliance_report', entityId: report.id,
      after: { report_type, risk_level, workflow_id },
      ip: req.ip,
    });

    logger.info('Compliance report generated', { tenantId, reportId: report.id, riskLevel: risk_level });
    return res.status(201).json({ data: report });
  } catch (err) {
    logger.error('POST /compliance/reports failed', { error: err.message, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── GET /compliance/reports/:id ─────────────────────────────────────────────
// Report-Details
router.get('/reports/:id', async (req, res) => {
  const { id }   = req.params;
  const tenantId = req.tenant_id;

  try {
    const result = await pool.query(
      `SELECT cr.*,
              w.title AS workflow_title,
              w.goal  AS workflow_goal,
              u.display_name AS approved_by_name,
              u.email        AS approved_by_email
       FROM compliance_reports cr
       LEFT JOIN workflows w ON w.id = cr.workflow_id
       LEFT JOIN users u ON u.id = cr.approved_by
       WHERE cr.id = $1 AND cr.tenant_id = $2`,
      [id, tenantId]
    );

    if (result.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Compliance report ${id} not found`);
    }

    // Audit-Log-Einträge für diesen Report abrufen
    const auditResult = await pool.query(
      `SELECT id, action, user_id, created_at, ip
       FROM audit_logs
       WHERE tenant_id = $1 AND entity_type = 'compliance_report' AND entity_id = $2
       ORDER BY created_at DESC
       LIMIT 20`,
      [tenantId, id]
    );

    return res.json({
      data: result.rows[0],
      audit_trail: auditResult.rows,
    });
  } catch (err) {
    logger.error('GET /compliance/reports/:id failed', { error: err.message, id, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

module.exports = router;
