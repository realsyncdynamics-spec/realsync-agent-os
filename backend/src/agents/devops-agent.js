// devops-agent.js
// OpenClaw DevOps-Agent — Express Route Handler
// POST /agent/devops/execute
//
// Dependencies:
//   npm install express uuid
//   (openclaw-client.js in same directory)

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { OpenClawClient, OpenClawError } = require('./openclaw-client');

const router = express.Router();

// ─── Constants ────────────────────────────────────────────────────────────────
const AGENT_VERSION       = '1.0.0';
const MAX_ACTION_RETRIES  = 3;
const RETRY_DELAY_BASE_MS = 1_000;

// ─── Simulated DB / credential store ─────────────────────────────────────────
// In production, replace with real DB queries (Prisma / pg / Knex / etc.)

/** @type {Map<string, {url: string, apiKey: string, label: string}>} */
const GATEWAY_CREDENTIALS_DB = new Map([
  ['gw-prod-01', {
    url:    process.env.GW_PROD_01_URL     || 'http://prod-host-01:8080',
    apiKey: process.env.GW_PROD_01_APIKEY  || 'prod-secret-01',
    label:  'Production Server 01',
  }],
  ['gw-prod-02', {
    url:    process.env.GW_PROD_02_URL     || 'http://prod-host-02:8080',
    apiKey: process.env.GW_PROD_02_APIKEY  || 'prod-secret-02',
    label:  'Production Server 02',
  }],
  ['gw-staging', {
    url:    process.env.GW_STAGING_URL     || 'http://staging-host:8080',
    apiKey: process.env.GW_STAGING_APIKEY  || 'staging-secret',
    label:  'Staging Environment',
  }],
]);

// ─── Simulated AgentRun DB ────────────────────────────────────────────────────

function writeAgentRunLog(entry) {
  // In production: INSERT INTO agent_runs (...) VALUES (...)
  console.log('[AgentRun]', JSON.stringify({
    ...entry,
    logged_at: new Date().toISOString(),
  }));
}

function updateAgentRunLog(agentRunId, update) {
  // In production: UPDATE agent_runs SET ... WHERE id = agentRunId
  console.log('[AgentRun:Update]', JSON.stringify({
    agent_run_id: agentRunId,
    ...update,
    updated_at: new Date().toISOString(),
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Validates the request body for required fields.
 *
 * @param {object} body
 * @returns {{ valid: boolean, error?: string }}
 */
function validateBody(body) {
  const required = ['task_id', 'workflow_id', 'tenant_id', 'action', 'gateway_id'];
  for (const field of required) {
    if (!body[field] || typeof body[field] !== 'string' || !body[field].trim()) {
      return { valid: false, error: `Missing or invalid field: ${field}` };
    }
  }
  return { valid: true };
}

/**
 * Fetch gateway credentials from DB.
 *
 * @param {string} gatewayId
 * @param {string} tenantId
 * @returns {{ url: string, apiKey: string, label: string } | null}
 */
async function getGatewayCredentials(gatewayId, tenantId) {
  // In production: SELECT url, api_key FROM gateways
  //                WHERE id = $1 AND tenant_id = $2 AND active = true
  const creds = GATEWAY_CREDENTIALS_DB.get(gatewayId);
  if (!creds) return null;
  return creds;
}

/**
 * Dispatch action to the appropriate OpenClawClient method.
 *
 * @param {OpenClawClient} client
 * @param {string}  action
 * @param {object}  params
 * @returns {Promise<any>}
 */
async function dispatchAction(client, action, params = {}) {
  switch (action) {
    case 'execute_script':
      return client.executeScript(
        params.script_name || params.scriptName,
        params.script_params || params.scriptParams || {}
      );

    case 'get_job_status':
      return client.getJobStatus(params.job_id || params.jobId);

    case 'get_logs':
      return client.getLogs(
        params.path,
        params.lines !== undefined ? Number(params.lines) : 100
      );

    case 'get_system_info':
      return client.getSystemInfo();

    case 'heartbeat':
      return client.heartbeat();

    default:
      throw new Error(`Unknown action: "${action}". Allowed: execute_script, get_job_status, get_logs, get_system_info, heartbeat`);
  }
}

// ─── Main Route Handler ───────────────────────────────────────────────────────

/**
 * POST /agent/devops/execute
 *
 * Body:
 * {
 *   "task_id":     "task-abc123",
 *   "workflow_id": "daily_health_check",
 *   "tenant_id":   "tenant-xyz",
 *   "action":      "execute_script",
 *   "gateway_id":  "gw-prod-01",
 *   "params": {
 *     "script_name":   "system_health_check.sh",
 *     "script_params": { "verbose": true }
 *   }
 * }
 *
 * Response:
 * {
 *   "status":       "success" | "error",
 *   "output":       { ... },
 *   "agent_run_id": "uuid"
 * }
 */
router.post('/execute', async (req, res) => {
  const agentRunId = uuidv4();
  const startedAt  = new Date().toISOString();

  // ── 1. Validate input ────────────────────────────────────────────────────
  const { valid, error: validationError } = validateBody(req.body);
  if (!valid) {
    return res.status(400).json({
      status:       'error',
      error:        validationError,
      agent_run_id: agentRunId,
    });
  }

  const {
    task_id,
    workflow_id,
    tenant_id,
    action,
    gateway_id,
    params = {},
  } = req.body;

  // ── 2. Write initial AgentRun log ────────────────────────────────────────
  writeAgentRunLog({
    agent_run_id: agentRunId,
    task_id,
    workflow_id,
    tenant_id,
    action,
    gateway_id,
    params,
    status:       'running',
    started_at:   startedAt,
    agent_version: AGENT_VERSION,
  });

  // ── 3. Fetch gateway credentials ─────────────────────────────────────────
  let credentials;
  try {
    credentials = await getGatewayCredentials(gateway_id, tenant_id);
  } catch (dbErr) {
    const errMsg = `DB error fetching credentials: ${dbErr.message}`;
    updateAgentRunLog(agentRunId, { status: 'error', error: errMsg });
    return res.status(500).json({
      status:       'error',
      error:        errMsg,
      agent_run_id: agentRunId,
    });
  }

  if (!credentials) {
    const errMsg = `Gateway not found or access denied: ${gateway_id} (tenant: ${tenant_id})`;
    updateAgentRunLog(agentRunId, { status: 'error', error: errMsg });
    return res.status(404).json({
      status:       'error',
      error:        errMsg,
      agent_run_id: agentRunId,
    });
  }

  // ── 4. Create OpenClaw client ─────────────────────────────────────────────
  const client = new OpenClawClient(credentials.url, credentials.apiKey, {
    timeoutMs:  30_000,
    maxRetries: 1,  // agent handles its own retry loop below
  });

  // ── 5. Execute with retry loop ────────────────────────────────────────────
  let lastError;
  let output;
  let attempt = 0;

  while (attempt < MAX_ACTION_RETRIES) {
    attempt++;
    try {
      output = await dispatchAction(client, action, params);
      break; // success
    } catch (err) {
      lastError = err;

      const isRetryable = !(err instanceof OpenClawError && err.statusCode >= 400 && err.statusCode < 500);

      console.warn(`[AgentRun:${agentRunId}] Attempt ${attempt} failed: ${err.message}`, {
        retryable: isRetryable,
        attempt,
      });

      if (!isRetryable || attempt >= MAX_ACTION_RETRIES) break;

      const delay = RETRY_DELAY_BASE_MS * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }

  // ── 6. Handle failure ─────────────────────────────────────────────────────
  if (!output && lastError) {
    const errMsg = lastError.message || 'Unknown error';
    const statusCode = lastError instanceof OpenClawError
      ? (lastError.statusCode || 500)
      : 502;

    updateAgentRunLog(agentRunId, {
      status:     'error',
      error:      errMsg,
      attempts:   attempt,
      finished_at: new Date().toISOString(),
    });

    return res.status(statusCode).json({
      status:       'error',
      error:        errMsg,
      attempts:     attempt,
      agent_run_id: agentRunId,
    });
  }

  // ── 7. Success ────────────────────────────────────────────────────────────
  const finishedAt = new Date().toISOString();

  updateAgentRunLog(agentRunId, {
    status:      'success',
    output,
    attempts:    attempt,
    finished_at: finishedAt,
  });

  return res.status(200).json({
    status:       'success',
    output,
    attempts:     attempt,
    gateway:      { id: gateway_id, label: credentials.label },
    agent_run_id: agentRunId,
    started_at:   startedAt,
    finished_at:  finishedAt,
  });
});

// ─── Health Probe for the Agent itself ───────────────────────────────────────

router.get('/health', (_req, res) => {
  res.json({
    status:  'ok',
    version: AGENT_VERSION,
    uptime:  process.uptime(),
  });
});

// ─── Express App Setup ────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Request logging middleware
  app.use((req, _res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });

  app.use('/agent/devops', router);

  // Global error handler
  app.use((err, _req, res, _next) => {
    console.error('[Unhandled Error]', err);
    res.status(500).json({ status: 'error', error: 'Internal server error' });
  });

  return app;
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  const app  = createApp();

  app.listen(PORT, () => {
    console.log(`[DevOps Agent v${AGENT_VERSION}] Listening on port ${PORT}`);
    console.log('Endpoint: POST /agent/devops/execute');
  });
}

module.exports = { createApp, router };

// ─── Example curl ─────────────────────────────────────────────────────────────
/*
curl -s -X POST http://localhost:3001/agent/devops/execute \
  -H "Content-Type: application/json" \
  -d '{
    "task_id":     "task-001",
    "workflow_id": "daily_health_check",
    "tenant_id":   "tenant-acme",
    "action":      "execute_script",
    "gateway_id":  "gw-prod-01",
    "params": {
      "script_name":   "system_health_check.sh",
      "script_params": { "verbose": true }
    }
  }'
*/
