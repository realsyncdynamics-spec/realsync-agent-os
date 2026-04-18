'use strict';

/**
 * OpenClaw Gateway — Main Server
 * Express HTTP server + WebSocket server for remote execution.
 *
 * Endpoints:
 *   GET  /health          — Public health-check
 *   GET  /system/info     — Host system metrics
 *   GET  /scripts         — List available scripts
 *   POST /execute         — Queue and run a script
 *   GET  /jobs/:id        — Poll job status / output
 *   GET  /jobs            — List recent jobs
 *   POST /logs/read       — Read a log file
 *
 * WebSocket (/ws):
 *   Client sends: {"type":"subscribe","job_id":"<id>"}
 *   Server sends: {"type":"data","line":"..."} and {"type":"complete","exit_code":0,"output":"..."}
 */

require('dotenv').config();

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const { authMiddleware } = require('./auth');
const jobRunner = require('./job-runner');
const { getInfo } = require('./system-info');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT, 10) || 8443;
const GATEWAY_ID = process.env.GATEWAY_ID || `gateway-${uuidv4().slice(0, 8)}`;
const SCRIPTS_DIR = path.resolve(process.env.SCRIPTS_DIR || path.join(__dirname, '..', 'scripts'));
const ALLOWED_EXTENSIONS = (process.env.ALLOWED_SCRIPT_EXTENSIONS || '.sh,.ps1,.py')
  .split(',')
  .map((e) => e.trim().toLowerCase());

const VERSION = require('../package.json').version;
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.use(helmet());
app.use(express.json({ limit: '1mb' }));

// Request logging
app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

// Auth — /health is public
app.use(authMiddleware);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /health — public, no auth */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    version: VERSION,
    gateway_id: GATEWAY_ID,
    node_version: process.version,
    timestamp: new Date().toISOString(),
  });
});

/** GET /system/info */
app.get('/system/info', async (req, res) => {
  try {
    const info = await getInfo();
    res.json(info);
  } catch (err) {
    logger.error(`/system/info error: ${err.message}`);
    res.status(500).json({ error: 'Failed to collect system information', detail: err.message });
  }
});

/** GET /scripts — list available scripts */
app.get('/scripts', (req, res) => {
  try {
    if (!fs.existsSync(SCRIPTS_DIR)) {
      return res.json({ scripts: [], scripts_dir: SCRIPTS_DIR });
    }
    const entries = fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true });
    const scripts = entries
      .filter((e) => {
        if (!e.isFile()) return false;
        const ext = path.extname(e.name).toLowerCase();
        return ALLOWED_EXTENSIONS.includes(ext);
      })
      .map((e) => {
        const fullPath = path.join(SCRIPTS_DIR, e.name);
        const stat = fs.statSync(fullPath);
        return {
          name: e.name,
          extension: path.extname(e.name).toLowerCase(),
          size_bytes: stat.size,
          modified_at: stat.mtime.toISOString(),
        };
      });
    res.json({ scripts, scripts_dir: SCRIPTS_DIR, count: scripts.length });
  } catch (err) {
    logger.error(`/scripts error: ${err.message}`);
    res.status(500).json({ error: 'Failed to list scripts', detail: err.message });
  }
});

/** POST /execute — queue a script */
app.post('/execute', async (req, res) => {
  const { script_name, params = {} } = req.body || {};

  if (!script_name || typeof script_name !== 'string') {
    return res.status(400).json({ error: 'script_name is required and must be a string' });
  }

  // Security: strip path traversal
  const safeName = path.basename(script_name);
  const scriptPath = path.join(SCRIPTS_DIR, safeName);

  // Extension whitelist
  const ext = path.extname(safeName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return res.status(400).json({
      error: `Script extension "${ext}" is not allowed. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
    });
  }

  // File must exist
  if (!fs.existsSync(scriptPath)) {
    return res.status(404).json({ error: `Script not found: ${safeName}` });
  }

  // Params must be a plain object
  if (typeof params !== 'object' || Array.isArray(params)) {
    return res.status(400).json({ error: 'params must be a plain object' });
  }

  const jobId = uuidv4();
  logger.info(`Queuing job ${jobId} for script ${safeName}`);

  // Respond immediately with jobId; execution is async
  res.status(202).json({ job_id: jobId, status: 'queued', script: safeName });

  // Fire and forget — errors are tracked inside job-runner
  jobRunner.run(jobId, scriptPath, params).catch((err) => {
    logger.error(`Job ${jobId} unhandled error: ${err.message}`);
  });
});

/** GET /jobs — list recent jobs */
app.get('/jobs', (req, res) => {
  const jobs = jobRunner.listJobs().map(sanitizeJob);
  res.json({ jobs, count: jobs.length });
});

/** GET /jobs/:id — poll job status */
app.get('/jobs/:id', (req, res) => {
  const job = jobRunner.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: `Job not found: ${req.params.id}` });
  }
  res.json(sanitizeJob(job));
});

/** POST /logs/read — read a log file */
app.post('/logs/read', (req, res) => {
  const { path: filePath, lines = 100 } = req.body || {};

  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'path is required' });
  }

  const maxLines = Math.min(Math.max(parseInt(lines, 10) || 100, 1), 10_000);
  const resolvedPath = path.resolve(filePath);

  // Basic safety: require absolute path, disallow relative traversal tricks
  if (!path.isAbsolute(resolvedPath)) {
    return res.status(400).json({ error: 'path must be absolute' });
  }

  try {
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: `File not found: ${resolvedPath}` });
    }

    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return res.status(400).json({ error: 'path must point to a file, not a directory' });
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const allLines = content.split('\n');
    const tailLines = allLines.slice(-maxLines);

    res.json({
      file: resolvedPath,
      file_size_bytes: stat.size,
      total_lines: allLines.length,
      returned_lines: tailLines.length,
      lines: tailLines,
    });
  } catch (err) {
    logger.error(`/logs/read error: ${err.message}`);
    res.status(500).json({ error: 'Failed to read file', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Error handlers
// ---------------------------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error(`Unhandled express error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: '/ws' });

/** Map<jobId, Set<WebSocket>> — active subscribers */
const wsSubscriptions = new Map();

wss.on('connection', (ws, req) => {
  logger.info(`WebSocket connected from ${req.socket.remoteAddress}`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }

    if (msg.type === 'subscribe' && msg.job_id) {
      const jobId = msg.job_id;
      logger.debug(`WS: client subscribed to job ${jobId}`);

      // Register subscription
      if (!wsSubscriptions.has(jobId)) wsSubscriptions.set(jobId, new Set());
      wsSubscriptions.get(jobId).add(ws);

      ws.on('close', () => {
        const subs = wsSubscriptions.get(jobId);
        if (subs) subs.delete(ws);
      });

      // If job already exists, send buffered output immediately
      const job = jobRunner.getJob(jobId);
      if (job) {
        for (const line of job.output) {
          safeSend(ws, { type: 'data', line });
        }
        if (job.status === 'done' || job.status === 'failed') {
          safeSend(ws, {
            type: 'complete',
            exit_code: job.exitCode,
            status: job.status,
            output: job.output.join('\n'),
          });
        }
      } else {
        safeSend(ws, { type: 'queued', job_id: jobId });
      }
    } else {
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type or missing job_id' }));
    }
  });

  ws.on('error', (err) => logger.warn(`WebSocket error: ${err.message}`));
});

// Forward job events to WebSocket subscribers
jobRunner.on('job:line', ({ jobId, line }) => {
  broadcast(jobId, { type: 'data', line });
});

jobRunner.on('job:done', ({ jobId, exitCode, output }) => {
  const job = jobRunner.getJob(jobId);
  broadcast(jobId, {
    type: 'complete',
    exit_code: exitCode,
    status: job ? job.status : 'done',
    output,
  });
  // Clean up subscription after a short delay
  setTimeout(() => wsSubscriptions.delete(jobId), 30_000);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function broadcast(jobId, payload) {
  const subs = wsSubscriptions.get(jobId);
  if (!subs || subs.size === 0) return;
  const msg = JSON.stringify(payload);
  for (const ws of subs) {
    safeSend(ws, msg, true); // raw string — already serialised
  }
}

function safeSend(ws, payload, raw = false) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(raw ? payload : JSON.stringify(payload));
  } catch (err) {
    logger.debug(`WebSocket send error: ${err.message}`);
  }
}

function sanitizeJob(job) {
  return {
    job_id: job.id,
    status: job.status,
    script: job.scriptPath ? path.basename(job.scriptPath) : null,
    started_at: job.startedAt,
    completed_at: job.completedAt,
    exit_code: job.exitCode,
    output_lines: job.output.length,
    output: job.output,
    pid: job.pid,
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info(`Created directory: ${dir}`);
  }
}

function start() {
  ensureDir(SCRIPTS_DIR);
  ensureDir(path.join(__dirname, '..', 'logs'));

  server.listen(PORT, () => {
    logger.info('─────────────────────────────────────────────');
    logger.info(`  OpenClaw Gateway v${VERSION}`);
    logger.info(`  Gateway ID : ${GATEWAY_ID}`);
    logger.info(`  HTTP+WS    : http://0.0.0.0:${PORT}`);
    logger.info(`  Scripts dir: ${SCRIPTS_DIR}`);
    logger.info(`  Node       : ${process.version}`);
    logger.info('─────────────────────────────────────────────');
  });

  // Graceful shutdown
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

function shutdown(signal) {
  logger.info(`Received ${signal} — shutting down gracefully`);
  wss.close();
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
}

start();
