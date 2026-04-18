'use strict';

// routes/tasks.js
// Express Router für Task-Management

const express = require('express');
const winston = require('winston');
const pool    = require('../db');

const router = express.Router({ mergeParams: true });

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

// ─── GET /workflows/:workflowId/tasks ────────────────────────────────────────
// Task-Liste für einen Workflow
router.get('/workflows/:workflowId/tasks', async (req, res) => {
  const { workflowId } = req.params;
  const tenantId       = req.tenant_id;
  const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit  = Math.min(100, parseInt(req.query.limit || '50', 10));
  const offset = (page - 1) * limit;

  try {
    // Sicherstellen dass Workflow dem Tenant gehört
    const wfCheck = await pool.query(
      'SELECT id FROM workflows WHERE id = $1 AND tenant_id = $2',
      [workflowId, tenantId]
    );
    if (wfCheck.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Workflow ${workflowId} not found`);
    }

    const [rows, countResult] = await Promise.all([
      pool.query(
        `SELECT t.*,
                (SELECT COUNT(*) FROM agent_runs ar WHERE ar.task_id = t.id) AS run_count
         FROM tasks t
         WHERE t.workflow_id = $1
         ORDER BY t.priority ASC, t.created_at ASC
         LIMIT $2 OFFSET $3`,
        [workflowId, limit, offset]
      ),
      pool.query(
        'SELECT COUNT(*) FROM tasks WHERE workflow_id = $1',
        [workflowId]
      ),
    ]);

    return res.json({
      data: rows.rows,
      meta: {
        total:  parseInt(countResult.rows[0].count, 10),
        page,
        limit,
        pages:  Math.ceil(parseInt(countResult.rows[0].count, 10) / limit),
      },
    });
  } catch (err) {
    logger.error('GET /workflows/:workflowId/tasks failed', { error: err.message, workflowId, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── GET /tasks/:id ───────────────────────────────────────────────────────────
// Task-Details + aktueller Status
router.get('/tasks/:id', async (req, res) => {
  const { id }  = req.params;
  const tenantId = req.tenant_id;

  try {
    const result = await pool.query(
      `SELECT t.*,
              w.tenant_id,
              w.title AS workflow_title,
              (SELECT COUNT(*) FROM agent_runs ar WHERE ar.task_id = t.id) AS run_count,
              (SELECT MAX(ar.created_at) FROM agent_runs ar WHERE ar.task_id = t.id) AS last_run_at
       FROM tasks t
       JOIN workflows w ON w.id = t.workflow_id
       WHERE t.id = $1 AND w.tenant_id = $2`,
      [id, tenantId]
    );

    if (result.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Task ${id} not found`);
    }

    return res.json({ data: result.rows[0] });
  } catch (err) {
    logger.error('GET /tasks/:id failed', { error: err.message, id, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

// ─── GET /tasks/:id/runs ──────────────────────────────────────────────────────
// Alle AgentRuns für einen Task (sortiert nach created_at DESC)
router.get('/tasks/:id/runs', async (req, res) => {
  const { id }   = req.params;
  const tenantId = req.tenant_id;
  const page   = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit  = Math.min(100, parseInt(req.query.limit || '20', 10));
  const offset = (page - 1) * limit;

  try {
    // Task muss zum Tenant gehören
    const taskCheck = await pool.query(
      `SELECT t.id FROM tasks t
       JOIN workflows w ON w.id = t.workflow_id
       WHERE t.id = $1 AND w.tenant_id = $2`,
      [id, tenantId]
    );
    if (taskCheck.rows.length === 0) {
      return problemDetail(res, 404, 'Not Found', `Task ${id} not found`);
    }

    const [rows, countResult] = await Promise.all([
      pool.query(
        `SELECT ar.id, ar.task_id, ar.model_used, ar.tokens_used, ar.tokens_input, ar.tokens_output,
                ar.duration_ms, ar.cost_usd, ar.success, ar.error_code, ar.created_at,
                ar.output
         FROM agent_runs ar
         WHERE ar.task_id = $1
         ORDER BY ar.created_at DESC
         LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      ),
      pool.query('SELECT COUNT(*) FROM agent_runs WHERE task_id = $1', [id]),
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
    logger.error('GET /tasks/:id/runs failed', { error: err.message, id, tenantId });
    return problemDetail(res, 500, 'Internal Server Error', err.message);
  }
});

module.exports = router;
