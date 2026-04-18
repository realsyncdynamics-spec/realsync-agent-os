/**
 * RealSyncDynamics Agent-OS — Express Application Entry Point
 *
 * Route structure:
 *   /health            — Health check (no auth)
 *   /auth/*            — Auth endpoints (no auth middleware)
 *   /webhooks/stripe   — Stripe webhooks (raw body, no auth)
 *   /api/*             — Protected API routes (JWT + audit log)
 *   /agent/*           — Internal agent routes (X-Agent-Key)
 */

'use strict';

require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');

// ---------------------------------------------------------------------------
// App init
// ---------------------------------------------------------------------------

const app = express();

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------

app.use(helmet());

app.use(
  cors({
    origin:      process.env.FRONTEND_URL || '*',
    credentials: true,
    methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Agent-Key'],
  })
);

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
// Health check (no auth)
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    status:              'ok',
    version:             '1.0.0',
    eu_ai_act_compliant: true,
    timestamp:           new Date().toISOString(),
    uptime_s:            Math.floor(process.uptime()),
  });
});

// ---------------------------------------------------------------------------
// Auth routes (no auth middleware)
// ---------------------------------------------------------------------------

app.use('/auth', require('./routes/auth'));

// ---------------------------------------------------------------------------
// Protected API routes (JWT + audit log)
// ---------------------------------------------------------------------------

const { authenticate }   = require('./middleware/auth');
const { auditMiddleware } = require('./middleware/audit');

// All /api/* routes require a valid JWT and are audit-logged
app.use('/api', authenticate);
app.use('/api', auditMiddleware);

app.use('/api/workflows',  require('./routes/workflows'));
app.use('/api/tasks',      require('./routes/tasks'));
app.use('/api/gateways',   require('./routes/gateways'));
app.use('/api/compliance', require('./routes/compliance'));
app.use('/api/billing',    require('./routes/billing'));

// ---------------------------------------------------------------------------
// Agent routes (internal — X-Agent-Key protected)
// ---------------------------------------------------------------------------

const { agentAuth } = require('./middleware/agent-auth');

// Apply agent auth to all /agent/* routes
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
    type:   'https://realsync.io/errors/not-found',
    title:  'Not Found',
    status: 404,
    detail: `${req.method} ${req.path} not found`,
  });
});

// ---------------------------------------------------------------------------
// RFC 9457 Error handler
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Log the full error server-side
  console.error('[error]', {
    message:    err.message,
    stack:      err.stack,
    path:       req.path,
    method:     req.method,
    request_id: req.headers['x-request-id'] || null,
  });

  // Propagate explicit HTTP status codes from thrown objects
  const status = err.status || err.statusCode || 500;

  // RFC 9457 Problem Details response
  const body = {
    type:   err.type || `https://realsync.io/errors/${status === 500 ? 'internal-server-error' : 'error'}`,
    title:  err.title || (status === 500 ? 'Internal Server Error' : 'Error'),
    status,
    detail: status === 500
      ? 'An unexpected error occurred. Please try again later.'
      : err.message || 'An error occurred.',
  };

  // Attach validation errors if present (e.g., from express-validator)
  if (err.errors) {
    body.errors = err.errors;
  }

  // Include request ID if available (useful for support correlation)
  if (req.headers['x-request-id']) {
    body.instance = req.headers['x-request-id'];
  }

  res.status(status).json(body);
});

// ---------------------------------------------------------------------------
// Server start + graceful shutdown
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);

const server = app.listen(PORT, () => {
  console.log(`RealSyncDynamics Agent-OS running on :${PORT}`);
  console.log(`  Environment : ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Frontend URL: ${process.env.FRONTEND_URL || '*'}`);
});

// Graceful shutdown on SIGTERM (sent by container orchestrators / process managers)
process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM received — closing HTTP server...');
  server.close(() => {
    console.log('[shutdown] HTTP server closed. Exiting.');
    process.exit(0);
  });
});

// Also handle SIGINT (Ctrl+C in dev)
process.on('SIGINT', () => {
  console.log('[shutdown] SIGINT received — closing HTTP server...');
  server.close(() => {
    console.log('[shutdown] HTTP server closed. Exiting.');
    process.exit(0);
  });
});

// Unhandled promise rejections — log and exit so the process manager restarts
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason, promise);
  // Optionally: process.exit(1);
});

module.exports = app; // Export for testing
