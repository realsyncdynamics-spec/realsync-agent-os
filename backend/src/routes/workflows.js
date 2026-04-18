'use strict';

// routes/workflows.js
// Express Router für Workflow-Management
// EU-AI-Act konform: vollständiges Audit-Logging für alle Mutationen

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const pool = require('../db');
const { AIManager, setupQueues } = require('../ai-manager');

const router = express.Router();

// ─── Logger ───────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Schreibt einen Audit-Log-Eintrag für mutierende Operationen.
 * Pflicht nach EU AI Act Art. 12.
 */
async function writeAuditLog({ tenantId, userId, action, entityType, entityId, before, after, ip, userAgent }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs
         (tenant_id, user_id, action, entity_type, entity_id, before, after, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tenantId, userId || null, action, entityType, entityId || null,
       before ? JSON.stringify(before) : null,
       after  ? JSON.stringify(after)  : null,
       ip || null, userAgent || null]
    );
  } catch (err) {
    logger.error('Audit log write failed', { error: err.message, action, entityId });
  }
}

/**
 * RFC 9457 Problem Details error response
 */
function problemDetail(res, status, title, detail, extra = {}) {
  return res.status(status).json({
    type:   `https://realsync.io/errors/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
    ...extra,
  });
}

// ─── GET /workflows ───────────────────────────────────────────────────────────
// Liste aller Workflows des Tenants (paginiert)
router.get('/', async (req, res) => {
  const tenantId = req.tenant_id;
  const page     = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit    = Math.min(100, parseInt(req.query.limit || '20', 10));
  const offset   = (page - 1) * limit;
  const status   = req.query.status || null;

  try {
    let queryText = `
      SELECT w.*, u.display_name AS created_by_name
      FROM workflows w
      LEFT JOIN users u ON u.id = w.created_by
      WHERE w.tenant_id = $1
    `;
    const params = [tenantId];

    if (status) {
      params.push(status);
      queryText += ` AND w.status = $${params.length}`;
    }

    queryText += ` ORDER BY w.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const [rows, countResult] = await Promise.all([
      pool.query(queryText, params),
      pool.query(
        `SELECT COUNT(*) FROM workflows WHERE tenant_id = $1${status ? ' AND status = $2' : ''}`,
        status ? [tenantId, status] : [tenantId]
      ),
    ]);

    return res.json({
      data:  rows.rows,
      meta: {
        total: parseInt(countResult.rows[0].count, 10),
        page,
        limit,
        pages: Math.ceil(parseInt(countResult.rows[0].count, 10) / limit),
      },
    });
  } catch (err) {
    logger.error('GET /workflows failed', { error: err.message, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── POST /workflows ──────────────────────────────────────────────────────────
// Neuen Workflow erstellen
router.post('/', async (req, res) => {
  const tenantId = req.tenant_id;
  const userId   = req.user?.id;
  const { title, goal, config } = req.body;

  if (!title || !goal) {
    return problemDetail(res, 400, 'Bad Request', 'title and goal are required');
  }

  try {
    const result = await pool.query(
      `INSERT INTO workflows (tenant_id, created_by, title, goal, config, status)
       VALUES ($1, $2, $3, $4, $5, 'draft')
       RETURNING *`,
      [tenantId, userId || null, title, goal, JSON.stringify(config || {})]
    );
    const workflow = result.rows[0];

    await writeAuditLog({
      tenantId, userId, action: 'workflow.create',
      entityType: 'workflow', entityId: workflow.id,
      after: workflow,
      ip: req.ip, userAgent: req.get('User-Agent'),
    });

    logger.info('Workflow created', { tenantId, workflowId: workflow.id });
    return res.status(201).json({ data: workflow });
  } catch (err) {
    logger.error('POST /workflows failed', { error: err.message, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── GET /workflows/:id ───────────────────────────────────────────────────────
// Workflow-Details
router.get('/:id', async (req, res) => {
  const { id }    = req.params;
  const tenantId  = req.tenant_id;

  try {
    const result = await pool.query(
      `SELECT w.*, u.display_name AS created_by_name,
              (SELECT COUNT(*) FROM tasks t WHERE t.workflow_id = w.id) AS task_count
       FROM workflows w
       LEFT JOIN users u ON u.id = w.created_by
       WHERE w.id = $1 AND w.tenant_id = $2`,
      [id, tenantId]
    );

    if (result.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Workflow ${id} not found`);
    }

    return res.json({ data: result.rows[0] });
  } catch (err) {
    logger.error('GET /workflows/:id failed', { error: err.message, id, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── PATCH /workflows/:id ─────────────────────────────────────────────────────
// Workflow updaten
router.patch('/:id', async (req, res) => {
  const { id }   = req.params;
  const tenantId = req.tenant_id;
  const userId   = req.user?.id;
  const { title, goal, config, status } = req.body;

  const allowedStatuses = ['draft', 'active', 'paused', 'completed', 'error'];
  if (status && !allowedStatuses.includes(status)) {
    return problemDetail(res, 400, 'Bad Request', `Invalid status. Allowed: ${allowedStatuses.join(', ')}`);
  }

  try {
    // Hole aktuellen Zustand für Audit-Log
    const current = await pool.query(
      'SELECT * FROM workflows WHERE id = $1 AND tenant_id = $2',
      [id, tenantId]
    );
    if (current.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Workflow ${id} not found`);
    }
    const before = current.rows[0];

    const updates = [];
    const params  = [];
    if (title  !== undefined) { params.push(title);                   updates.push(`title = $${params.length}`); }
    if (goal   !== undefined) { params.push(goal);                    updates.push(`goal = $${params.length}`); }
    if (config !== undefined) { params.push(JSON.stringify(config));  updates.push(`config = $${params.length}`); }
    if (status !== undefined) { params.push(status);                  updates.push(`status = $${params.length}`); }

    if (updates.length === 0) {
      return problemDetail(res, 400, 'Bad Request', 'No updateable fields provided');
    }

    params.push(new Date());
    updates.push(`updated_at = $${params.length}`);
    params.push(id, tenantId);

    const result = await pool.query(
      `UPDATE workflows SET ${updates.join(', ')}
       WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
       RETURNING *`,
      params
    );
    const updated = result.rows[0];

    await writeAuditLog({
      tenantId, userId, action: 'workflow.update',
      entityType: 'workflow', entityId: id,
      before, after: updated,
      ip: req.ip, userAgent: req.get('User-Agent'),
    });

    logger.info('Workflow updated', { tenantId, workflowId: id });
    return res.json({ data: updated });
  } catch (err) {
    logger.error('PATCH /workflows/:id failed', { error: err.message, id, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── DELETE /workflows/:id ────────────────────────────────────────────────────
// Soft-delete (status → 'completed', kein echtes Löschen für Audit-Trail)
router.delete('/:id', async (req, res) => {
  const { id }   = req.params;
  const tenantId = req.tenant_id;
  const userId   = req.user?.id;

  try {
    const current = await pool.query(
      'SELECT * FROM workflows WHERE id = $1 AND tenant_id = $2',
      [id, tenantId]
    );
    if (current.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Workflow ${id} not found`);
    }

    // Soft-delete: status auf 'completed' setzen statt DELETE
    await pool.query(
      `UPDATE workflows SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    await writeAuditLog({
      tenantId, userId, action: 'workflow.delete',
      entityType: 'workflow', entityId: id,
      before: current.rows[0], after: { status: 'completed' },
      ip: req.ip, userAgent: req.get('User-Agent'),
    });

    logger.info('Workflow soft-deleted', { tenantId, workflowId: id });
    return res.status(204).send();
  } catch (err) {
    logger.error('DELETE /workflows/:id failed', { error: err.message, id, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── POST /workflows/:id/execute ─────────────────────────────────────────────
// Workflow starten (enqueues in BullMQ via AIManager)
router.post('/:id/execute', async (req, res) => {
  const { id }   = req.params;
  const tenantId = req.tenant_id;
  const userId   = req.user?.id;

  try {
    const result = await pool.query(
      'SELECT * FROM workflows WHERE id = $1 AND tenant_id = $2',
      [id, tenantId]
    );
    if (result.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Workflow ${id} not found`);
    }
    const workflow = result.rows[0];

    if (workflow.status === 'running') {
      return problemDetail(res, 409, 'Conflict', 'Workflow is already running');
    }

    // AIManager laden und Workflow starten
    const { taskQueue, approvalQueue, deadLetterQueue } = setupQueues();
    const llmClient = {
      complete: async (prompt) => {
        const axios = require('axios');
        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: process.env.OPENAI_MODEL || 'gpt-4o',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
          },
          { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
        );
        return response.data.choices[0].message.content;
      },
    };
    const aiManager = new AIManager(llmClient, taskQueue, { collection: () => ({ insertOne: async (d) => ({ insertedId: 'ok' }) }) }, { approvalQueue, deadLetterQueue });

    const execResult = await aiManager.processGoal(tenantId, workflow.id, workflow.goal, req.body.context || {});

    // Status auf 'active' setzen
    await pool.query(
      `UPDATE workflows SET status = 'active', last_run_at = NOW(), run_count = run_count + 1, updated_at = NOW() WHERE id = $1`,
      [id]
    );

    await writeAuditLog({
      tenantId, userId, action: 'workflow.execute',
      entityType: 'workflow', entityId: id,
      after: { status: 'active', trace_id: execResult.trace_id },
      ip: req.ip, userAgent: req.get('User-Agent'),
    });

    logger.info('Workflow execution started', { tenantId, workflowId: id, taskCount: execResult.task_count });
    return res.status(202).json({ data: execResult });
  } catch (err) {
    logger.error('POST /workflows/:id/execute failed', { error: err.message, id, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── POST /workflows/:id/pause ────────────────────────────────────────────────
router.post('/:id/pause', async (req, res) => {
  const { id }   = req.params;
  const tenantId = req.tenant_id;
  const userId   = req.user?.id;

  try {
    const result = await pool.query(
      'SELECT * FROM workflows WHERE id = $1 AND tenant_id = $2',
      [id, tenantId]
    );
    if (result.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Workflow ${id} not found`);
    }

    await pool.query(
      `UPDATE workflows SET status = 'paused', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    await writeAuditLog({
      tenantId, userId, action: 'workflow.pause',
      entityType: 'workflow', entityId: id,
      before: { status: result.rows[0].status }, after: { status: 'paused' },
      ip: req.ip, userAgent: req.get('User-Agent'),
    });

    return res.json({ data: { id, status: 'paused' } });
  } catch (err) {
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── POST /workflows/:id/resume ───────────────────────────────────────────────
router.post('/:id/resume', async (req, res) => {
  const { id }   = req.params;
  const tenantId = req.tenant_id;
  const userId   = req.user?.id;

  try {
    const result = await pool.query(
      'SELECT * FROM workflows WHERE id = $1 AND tenant_id = $2',
      [id, tenantId]
    );
    if (result.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Workflow ${id} not found`);
    }
    if (result.rows[0].status !== 'paused') {
      return problemDetail(res, 409, 'Conflict', 'Only paused workflows can be resumed');
    }

    await pool.query(
      `UPDATE workflows SET status = 'active', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    await writeAuditLog({
      tenantId, userId, action: 'workflow.resume',
      entityType: 'workflow', entityId: id,
      before: { status: 'paused' }, after: { status: 'active' },
      ip: req.ip, userAgent: req.get('User-Agent'),
    });

    return res.json({ data: { id, status: 'active' } });
  } catch (err) {
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── POST /workflows/:id/approve ─────────────────────────────────────────────
// Human-Approval für High-Risk Steps (EU AI Act Art. 14)
router.post('/:id/approve', async (req, res) => {
  const { id }   = req.params;
  const tenantId = req.tenant_id;
  const userId   = req.user?.id;
  const { task_id, decision, reason } = req.body;

  if (!task_id || !decision) {
    return problemDetail(res, 400, 'Bad Request', 'task_id and decision are required');
  }
  if (!['approve', 'reject'].includes(decision)) {
    return problemDetail(res, 400, 'Bad Request', 'decision must be "approve" or "reject"');
  }
  if (!userId) {
    return problemDetail(res, 401, 'Unauthorized', 'Human approval requires authenticated user');
  }

  try {
    // Workflow existiert und gehört zum Tenant
    const wfResult = await pool.query(
      'SELECT id FROM workflows WHERE id = $1 AND tenant_id = $2',
      [id, tenantId]
    );
    if (wfResult.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Workflow ${id} not found`);
    }

    // Task Status entsprechend updaten
    const newTaskStatus = decision === 'approve' ? 'running' : 'failed';
    const taskResult = await pool.query(
      `UPDATE tasks SET status = $1, updated_at = NOW()
       WHERE id = $2 AND workflow_id = $3
       RETURNING *`,
      [newTaskStatus, task_id, id]
    );

    if (taskResult.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Task ${task_id} not found in workflow ${id}`);
    }

    await writeAuditLog({
      tenantId, userId, action: `workflow.human_approval.${decision}`,
      entityType: 'task', entityId: task_id,
      after: { decision, reason, approved_by: userId },
      ip: req.ip, userAgent: req.get('User-Agent'),
    });

    logger.info('Human approval recorded', { tenantId, workflowId: id, taskId: task_id, decision, userId });
    return res.json({ data: { workflow_id: id, task_id, decision, approved_by: userId, reason } });
  } catch (err) {
    logger.error('POST /workflows/:id/approve failed', { error: err.message, id, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

module.exports = router;
