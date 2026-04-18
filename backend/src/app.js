'use strict';

// app.js
// RealSyncDynamics Agent-OS — Express-Hauptanwendung
// EU-AI-Act konform | Node.js 20 LTS

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const winston = require('winston');

// ─── Logger ───────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === 'development'
        ? winston.format.combine(winston.format.colorize(), winston.format.simple())
        : winston.format.json(),
    }),
  ],
});

// ─── DB & Middleware ──────────────────────────────────────────────────────────
const db                             = require('./db');
const { authMiddleware }             = require('./middleware/auth');
const { auditMiddleware }            = require('./middleware/audit');

// ─── Routes ───────────────────────────────────────────────────────────────────
const workflowsRouter  = require('./routes/workflows');
const tasksRouter      = require('./routes/tasks');
const gatewaysRouter   = require('./routes/gateways');
const complianceRouter = require('./routes/compliance');

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();

// Security-Headers (OWASP, CSP etc.)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      objectSrc:  ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
}));

// CORS-Konfiguration
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:3001',
  'https://app.realsync.io',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Erlaubt Requests ohne Origin (z.B. curl, Postman, Server-to-Server)
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: Origin ${origin} not allowed`));
  },
  methods:            ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders:     ['Authorization', 'Content-Type', 'X-Request-ID'],
  exposedHeaders:     ['X-Request-ID', 'X-Rate-Limit-Remaining'],
  credentials:        true,
  maxAge:             86400, // 24h Preflight-Cache
}));

// JSON Body Parser (max 10MB für große Workflow-Configs)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

// Request-ID für Tracing
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  req.id = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
});

// Request-Logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('HTTP Request', {
      method:    req.method,
      path:      req.path,
      status:    res.statusCode,
      duration:  `${Date.now() - start}ms`,
      requestId: req.id,
      ip:        req.ip,
    });
  });
  next();
});

// ─── Health-Check (kein Auth erforderlich) ────────────────────────────────────
app.get('/health', async (req, res) => {
  const dbHealth = await db.healthCheck();
  const status   = dbHealth.status === 'ok' ? 200 : 503;

  return res.status(status).json({
    status:    dbHealth.status === 'ok' ? 'ok' : 'degraded',
    version:   process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString(),
    services: {
      database: dbHealth,
      redis: {
        status: 'ok', // TODO: Redis-Health-Check implementieren
      },
    },
    eu_ai_act_compliant: true,
  });
});

// ─── Stripe Webhook (kein Auth, eigene Signatur-Verifikation) ────────────────
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }), // Raw body für Signatur-Verifikation
  async (req, res) => {
    let event;

    try {
      const stripe        = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      const sig           = req.headers['stripe-signature'];

      if (!sig || !webhookSecret) {
        logger.warn('Stripe webhook missing signature or secret');
        return res.status(400).json({ error: 'Missing Stripe signature' });
      }

      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      logger.error('Stripe webhook signature verification failed', { error: err.message });
      return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    logger.info('Stripe webhook received', { type: event.type, id: event.id });

    // Stripe-Events verarbeiten
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId   = subscription.customer;
        const planId       = subscription.items.data[0]?.price.id;

        // Plan aus Stripe-Price-ID ableiten
        let plan = 'free';
        if (planId === process.env.STRIPE_STARTER_PRICE_ID)      plan = 'starter';
        if (planId === process.env.STRIPE_PROFESSIONAL_PRICE_ID)  plan = 'professional';
        if (planId === process.env.STRIPE_ENTERPRISE_PRICE_ID)    plan = 'enterprise';

        try {
          await db.query(
            `UPDATE tenants SET plan = $1, stripe_subscription_id = $2, updated_at = NOW()
             WHERE stripe_customer_id = $3`,
            [plan, subscription.id, customerId]
          );
          logger.info('Tenant plan updated via Stripe webhook', { customerId, plan });
        } catch (dbErr) {
          logger.error('Failed to update tenant plan', { error: dbErr.message, customerId });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId   = subscription.customer;

        try {
          await db.query(
            `UPDATE tenants SET plan = 'free', stripe_subscription_id = NULL, updated_at = NOW()
             WHERE stripe_customer_id = $1`,
            [customerId]
          );
          logger.info('Tenant plan reset to free (subscription deleted)', { customerId });
        } catch (dbErr) {
          logger.error('Failed to reset tenant plan', { error: dbErr.message, customerId });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice    = event.data.object;
        const customerId = invoice.customer;
        logger.warn('Stripe payment failed', { customerId, invoiceId: invoice.id });
        // TODO: Benachrichtigung an Tenant-Admin senden
        break;
      }

      default:
        logger.debug('Unhandled Stripe event', { type: event.type });
    }

    return res.json({ received: true });
  }
);

// ─── Authentifizierte API-Routes ──────────────────────────────────────────────
// Auth-Middleware für alle /api/* Routen
app.use('/api', authMiddleware);

// Audit-Middleware für mutierende Operationen (nach Auth, damit tenant_id verfügbar)
app.use('/api', auditMiddleware);

// Route-Handler
app.use('/api/workflows', workflowsRouter);
app.use('/api',           tasksRouter);     // /api/workflows/:workflowId/tasks und /api/tasks/:id
app.use('/api/gateways',  gatewaysRouter);
app.use('/api/compliance', complianceRouter);

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  return res.status(404).json({
    type:   'https://realsync.io/errors/not-found',
    title:  'Not Found',
    status: 404,
    detail: `Route ${req.method} ${req.path} not found`,
  });
});

// ─── Error Handler (RFC 9457 Problem Details) ─────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', {
    error:     err.message,
    stack:     err.stack,
    requestId: req.id,
    path:      req.path,
    method:    req.method,
  });

  // CORS-Fehler
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({
      type:   'https://realsync.io/errors/cors-error',
      title:  'Forbidden',
      status: 403,
      detail: err.message,
    });
  }

  const status = err.status || err.statusCode || 500;
  return res.status(status).json({
    type:      `https://realsync.io/errors/${status === 500 ? 'internal-server-error' : 'error'}`,
    title:     err.title || (status === 500 ? 'Internal Server Error' : 'Error'),
    status,
    detail:    process.env.NODE_ENV === 'production' && status === 500
               ? 'An unexpected error occurred'
               : err.message,
    requestId: req.id,
  });
});

// ─── Server-Start & Graceful Shutdown ─────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);

const server = app.listen(PORT, () => {
  logger.info(`RealSyncDynamics Agent-OS Backend gestartet`, {
    port:        PORT,
    environment: process.env.NODE_ENV || 'development',
    version:     process.env.npm_package_version || '1.0.0',
    eu_ai_act:   'EU AI Act Art. 12 Logging aktiv',
  });
});

// Graceful Shutdown bei SIGTERM (z.B. Cloud Run, Kubernetes)
async function gracefulShutdown(signal) {
  logger.info(`${signal} empfangen. Starte graceful shutdown...`);

  server.close(async () => {
    logger.info('HTTP-Server geschlossen');

    try {
      await db.close();
      logger.info('Datenbankverbindungen geschlossen');
    } catch (err) {
      logger.error('Fehler beim Schließen der DB-Verbindung', { error: err.message });
    }

    logger.info('Graceful shutdown abgeschlossen');
    process.exit(0);
  });

  // Notfall-Exit nach 30 Sekunden
  setTimeout(() => {
    logger.error('Graceful shutdown timeout — forcing exit');
    process.exit(1);
  }, 30_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack:  reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

module.exports = app; // für Tests
