/**
 * RealSyncDynamics Agent-OS — Express Application Entry Point v1.5.0
 *
 * Sprint 6: Worker integration via ENABLE_WORKERS flag.
 *
 * Route structure:
 *   /health            — Liveness probe (no auth, Cloud Run)
 *   /health/ready      — Readiness probe (DB + Redis check)
 *   /auth/*            — Auth endpoints (no JWT required)
 *   /webhooks/stripe   — Stripe webhooks (raw body, no auth)
 *   /api/*             — Protected API routes (JWT + audit log)
 *   /agent/*           — Internal agent routes (X-Agent-Key)
 */

'use strict';

require('dotenv').config();

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');

// ---------------------------------------------------------------------------
// App init
// ---------------------------------------------------------------------------

const app = express();

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------

app.use(helmet());
app.set('trust proxy', 1);

app.use(
  cors({
    origin:      process.env.FRONTEND_URL || '*',
    credentials: true,
    methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Agent-Key', 'X-Request-ID'],
  })
);

// ---------------------------------------------------------------------------
// Global rate limiter
// ---------------------------------------------------------------------------

app.use(
  rateLimit({
    windowMs:        60 * 1000,
    max:             100,
    standardHeaders: true,
    legacyHeaders:   false,
    message: {
      type:   'https://realsync.io/errors/rate-limit',
      title:  'Too Many Requests',
      status: 429,
      detail: 'You have exceeded the request rate limit. Please try again later.',
    },
  })
);

// ---------------------------------------------------------------------------
// Request ID injection
// ---------------------------------------------------------------------------

app.use((req, _res, next) => {
  req.requestId = req.headers['x-request-id'] ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  next();
});

// ---------------------------------------------------------------------------
// Stripe webhook — MUST be before express.json()
// ---------------------------------------------------------------------------

app.use(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  require('./routes/stripe-webhook')
);

// ---------------------------------------------------------------------------
// Body parsers
// ---------------------------------------------------------------------------

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------------------------------------------------------------------------
// Health routes (no auth)
// ---------------------------------------------------------------------------

app.use('/health', require('./routes/health'));

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.use('/auth', require('./routes/auth'));

// ---------------------------------------------------------------------------
// Protected API routes
// ---------------------------------------------------------------------------

const { authenticate }    = require('./middleware/auth');
const { auditMiddleware } = require('./middleware/audit');

app.use('/api', authenticate);
app.use('/api', auditMiddleware);

app.use('/api/workflows',  require('./routes/workflows'));
app.use('/api/tasks',      require('./routes/tasks'));
app.use('/api/gateways',   require('./routes/gateways'));
app.use('/api/compliance', require('./routes/compliance'));
app.use('/api/billing',    require('./routes/billing'));
app.use('/api/approvals',  require('./routes/approvals'));
app.use('/api/audit',      require('./routes/audit'));
app.use('/api/invoices',   require('./routes/invoices'));

// ---------------------------------------------------------------------------
// Agent routes (X-Agent-Key)
// ---------------------------------------------------------------------------

const { agentAuth } = require('./middleware/agent-auth');

app.use('/agent', agentAuth);
app.use('/agent/devops',     require('./agents/devops-agent'));
app.use('/agent/marketing',  require('./agents/marketing-agent'));
app.use('/agent/compliance', require('./agents/compliance-agent'));
app.use('/agent/research',   require('./agents/research-agent'));

// ---------------------------------------------------------------------------
// 404 handler
// ---------------------------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    type:     'https://realsync.io/errors/not-found',
    title:    'Not Found',
    status:   404,
    detail:   `${req.method} ${req.path} not found`,
    instance: req.requestId,
  });
});

// ---------------------------------------------------------------------------
// RFC 9457 Global Error Handler
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(JSON.stringify({
    level:      'error',
    message:    err.message,
    stack:      err.stack,
    path:       req.path,
    method:     req.method,
    request_id: req.requestId,
    tenant_id:  req.user?.tenant_id,
    user_id:    req.user?.id,
  }));

  const status = err.status || err.statusCode || 500;
  const body = {
    type:     err.type || `https://realsync.io/errors/${status === 500 ? 'internal' : 'error'}`,
    title:    err.title || (status === 500 ? 'Internal Server Error' : 'Error'),
    status,
    detail:   status === 500
      ? 'An unexpected error occurred. Please try again later.'
      : (err.message || 'An error occurred.'),
    instance: req.requestId,
  };
  if (err.errors) body.errors = err.errors;
  res.status(status).json(body);
});

// ---------------------------------------------------------------------------
// Server start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '8080', 10);

const server = app.listen(PORT, async () => {
  console.log(JSON.stringify({
    level:       'info',
    message:     'RealSyncDynamics Agent-OS started',
    version:     '1.5.0',
    port:        PORT,
    environment: process.env.NODE_ENV || 'development',
    workers:     process.env.ENABLE_WORKERS === 'true' ? 'enabled' : 'disabled',
    pid:         process.pid,
  }));

  // ── Start BullMQ workers if enabled ────────────────────────
  // Set ENABLE_WORKERS=true in production (Cloud Run) only when Redis is available.
  // Workers run in the same process for simplicity; extract to a separate
  // Cloud Run Job for high-volume deployments.
  if (process.env.ENABLE_WORKERS === 'true' && process.env.REDIS_URL) {
    try {
      const { start: startWorkers } = require('./workers/worker-registry');
      await startWorkers();
      console.log(JSON.stringify({ level: 'info', message: 'BullMQ workers started' }));
    } catch (err) {
      // Non-fatal: server continues even if workers fail to start
      console.error(JSON.stringify({
        level:   'error',
        message: 'Failed to start BullMQ workers — continuing without workers',
        error:   err.message,
      }));
    }
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = async (signal) => {
  console.log(JSON.stringify({ level: 'info', message: `${signal} received — shutting down` }));

  // Stop accepting new connections
  server.close(async () => {
    // Stop workers gracefully before exit
    if (process.env.ENABLE_WORKERS === 'true') {
      try {
        const { stop: stopWorkers } = require('./workers/worker-registry');
        await stopWorkers();
        console.log(JSON.stringify({ level: 'info', message: 'BullMQ workers stopped' }));
      } catch { /* ignore */ }
    }

    // Close DB pool
    try {
      const pool = require('./db');
      await pool.end();
      console.log(JSON.stringify({ level: 'info', message: 'DB pool closed' }));
    } catch { /* ignore */ }

    console.log(JSON.stringify({ level: 'info', message: 'Shutdown complete. Exiting.' }));
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 15_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ level: 'error', message: 'unhandledRejection', reason: String(reason) }));
});

module.exports = app;
