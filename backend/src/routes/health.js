/**
 * RealSyncDynamics Agent-OS — Deep Health Check Route
 *
 * GET /health         — lightweight liveness probe (no DB, used by Cloud Run)
 * GET /health/ready   — readiness probe: checks DB + Redis connectivity
 * GET /health/deep    — full diagnostics (admin only, not exposed to LB)
 */

'use strict';

const express = require('express');
const pool    = require('../db');

const router  = express.Router();
const START   = Date.now();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function checkDatabase() {
  const t0 = Date.now();
  try {
    const { rows } = await pool.query('SELECT 1 AS ok, NOW() AS db_time');
    return { status: 'ok', latency_ms: Date.now() - t0, db_time: rows[0].db_time };
  } catch (err) {
    return { status: 'error', latency_ms: Date.now() - t0, error: err.message };
  }
}

async function checkRedis() {
  const t0 = Date.now();
  try {
    // Lazy import — Redis is optional (BullMQ). If not configured, report degraded.
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      return { status: 'not_configured', latency_ms: 0 };
    }
    const { default: IORedis } = await import('ioredis');
    const client = new IORedis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      lazyConnect: true,
    });
    await client.connect();
    await client.ping();
    await client.quit();
    return { status: 'ok', latency_ms: Date.now() - t0 };
  } catch (err) {
    return { status: 'error', latency_ms: Date.now() - t0, error: err.message };
  }
}

function memoryStats() {
  const mem = process.memoryUsage();
  return {
    rss_mb:        Math.round(mem.rss / 1024 / 1024),
    heap_used_mb:  Math.round(mem.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    external_mb:   Math.round(mem.external / 1024 / 1024),
  };
}

// ─── GET /health — liveness (instant, no I/O) ────────────────────────────────

router.get('/', (_req, res) => {
  res.status(200).json({
    status:              'ok',
    service:             'realsync-backend',
    version:             process.env.npm_package_version || '1.3.0',
    environment:         process.env.NODE_ENV || 'development',
    eu_ai_act_compliant: true,
    uptime_s:            Math.floor(process.uptime()),
    timestamp:           new Date().toISOString(),
  });
});

// ─── GET /health/ready — readiness (checks DB + Redis) ───────────────────────

router.get('/ready', async (_req, res) => {
  const [db, redis] = await Promise.all([checkDatabase(), checkRedis()]);

  const allOk = db.status === 'ok' &&
                (redis.status === 'ok' || redis.status === 'not_configured');

  const status = allOk ? 200 : 503;
  const overall = allOk ? 'ready' : 'not_ready';

  res.status(status).json({
    status:    overall,
    timestamp: new Date().toISOString(),
    checks: {
      database: db,
      redis,
    },
  });
});

// ─── GET /health/deep — full diagnostics (internal use only) ─────────────────
// Cloud Run: do NOT expose this path via Load Balancer rules.
// Intended for ops dashboards behind VPC or authenticated proxy.

router.get('/deep', async (req, res) => {
  // Require internal key or admin JWT
  const internalKey = req.headers['x-internal-key'];
  if (internalKey !== process.env.INTERNAL_HEALTH_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const [db, redis] = await Promise.all([checkDatabase(), checkRedis()]);

  let tenantCount = 0;
  let userCount   = 0;
  try {
    const t = await pool.query('SELECT COUNT(*) FROM tenants');
    const u = await pool.query('SELECT COUNT(*) FROM users');
    tenantCount = parseInt(t.rows[0].count, 10);
    userCount   = parseInt(u.rows[0].count, 10);
  } catch { /* non-critical */ }

  res.status(200).json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    uptime_s:  Math.floor(process.uptime()),
    started_at: new Date(START).toISOString(),
    version:   process.env.npm_package_version || '1.3.0',
    node_version: process.version,
    environment: process.env.NODE_ENV || 'development',
    memory: memoryStats(),
    database: db,
    redis,
    business: {
      tenant_count: tenantCount,
      user_count:   userCount,
    },
    env_vars_set: [
      'DATABASE_URL',
      'REDIS_URL',
      'JWT_SECRET',
      'OPENAI_API_KEY',
      'STRIPE_SECRET_KEY',
      'OPENCLAW_API_KEY',
    ].map(k => ({ key: k, set: !!process.env[k] })),
  });
});

module.exports = router;
