/**
 * RealSyncDynamics Agent-OS — Express Application Entry Point v1.4.0
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
app.set('trust proxy', 1); // Required behind Cloud Run / GCP LB

app.use(
  cors({
    origin:      process.env.FRONTEND_URL || '*',
    credentials: true,
    methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Agent-Key', 'X-Request-ID'],
  })
);

// ---------------------------------------------------------------------------
// Global rate limiter (100 req/min per IP across all routes)
// Individual routes (auth) apply stricter limits on top
// ---------------------------------------------------------------------------

app.use(
  rateLimit({
    windowMs:         60 * 1000,
    max:              100,
    standardHeaders:  true,
    legacyHeaders:    false,
    message: {
      type:   'https://realsync.io/errors/rate-limit',
      title:  'Too Many Requests',
      status: 429,
      detail: 'You have exceeded the request rate limit. Please try again later.',
    },
  })
);

// ---------------------------------------------------------------------------
// Request ID injection (for log correlation)
// ---------------------------------------------------------------------------

app.use((req, _res, next) => {
  req.requestId = req.headers['x-request-id'] ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  next();
});

// ---------------------------------------------------------------------------
// Stripe webhook — MUST come before express.json() so raw body is preserved
// ---------------------------------------------------------------------------

app.use(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  require('./routes/stripe-webhook')
);

// ---------------------------------------------------------------------------
// Body parsers (after stripe webhook route)
// ---------------------------------------------------------------------------

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------------------------------------------------------------------------
// Health routes (no auth — Cloud Run liveness + readiness probes)
// ---------------------------------------------------------------------------

app.use('/health', require('./routes/health'));

// ---------------------------------------------------------------------------
// Auth routes (no auth middleware)
// ---------------------------------------------------------------------------

app.use('/auth', require('./routes/auth'));

// ---------------------------------------------------------------------------
// Protected API routes (JWT + audit log)
// ---------------------------------------------------------------------------

const { authenticate }   = require('./middleware/auth');
const { auditMiddleware } = require('./middleware/audit');

app.use('/api', authenticate);
app.use('/api', auditMiddleware);

app.use('/api/workflows',  require('./routes/workflows'));
app.use('/api/tasks',      require('./routes/tasks'));
app.use('/api/gateways',   require('./routes/gateways'));
app.use('/api/compliance', require('./routes/compliance'));
app.use('/api/billing',    require('./routes/billing'));
app.use('/api/approvals',  require('./routes/approvals'));   // Sprint 4: Human-in-the-loop
app.use('/api/audit',      require('./routes/audit'));       // Sprint 4: Audit log query

// ---------------------------------------------------------------------------
// Agent routes (internal — X-Agent-Key protected)
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
// Server start + graceful shutdown
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '8080', 10);

const server = app.listen(PORT, () => {
  console.log(JSON.stringify({
    level:       'info',
    message:     'RealSyncDynamics Agent-OS started',
    port:        PORT,
    environment: process.env.NODE_ENV || 'development',
    pid:         process.pid,
  }));
});

const shutdown = (signal) => {
  console.log(JSON.stringify({ level: 'info', message: `${signal} received — shutting down` }));
  server.close(() => {
    console.log(JSON.stringify({ level: 'info', message: 'HTTP server closed. Exiting.' }));
    process.exit(0);
  });
  // Force exit after 10s if graceful shutdown stalls
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({ level: 'error', message: 'unhandledRejection', reason: String(reason) }));
});

module.exports = app;
