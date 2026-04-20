'use strict';

/**
 * Health Route Tests — Sprint 10
 *
 * Tests:
 *   GET /health       — liveness (no DB required)
 *   GET /health/ready — readiness (mocked DB + Redis)
 *   GET /health/deep  — admin endpoint (auth guard)
 */

const request = require('supertest');

// ── Mock DB pool before requiring app ────────────────────────────────────────
jest.mock('../db', () => ({
  query: jest.fn().mockResolvedValue({
    rows: [{ ok: 1, db_time: new Date().toISOString() }],
  }),
}));

// ── Mock ioredis (used in /health/ready) ─────────────────────────────────────
jest.mock('ioredis', () => {
  const mock = jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    ping:    jest.fn().mockResolvedValue('PONG'),
    quit:    jest.fn().mockResolvedValue(undefined),
  }));
  mock.default = mock;
  return mock;
});

let app;

beforeAll(() => {
  process.env.NODE_ENV           = 'test';
  process.env.JWT_SECRET         = 'test_jwt_secret_32_chars_minimum_x';
  process.env.JWT_REFRESH_SECRET = 'test_refresh_secret_32_chars_minx';
  process.env.AGENT_INTERNAL_KEY = 'test_agent_key_16c';
  process.env.GATEWAY_SECRET     = 'test_gateway_secret';
  process.env.INTERNAL_HEALTH_KEY = 'test_health_key_secret';
  process.env.REDIS_URL          = '';  // empty = not_configured, skips real connect
  process.env.DATABASE_URL       = 'postgresql://x:x@localhost/x';
  process.env.ENABLE_WORKERS     = 'false';

  // Suppress worker startup in tests
  app = require('../app');
});

afterAll(async () => {
  // Close DB pool if exposed
  try {
    const pool = require('../db');
    if (pool.end) await pool.end();
  } catch { /* ignore */ }
});

// ── GET /health (liveness) ────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('includes eu_ai_act_compliant: true', async () => {
    const res = await request(app).get('/health');
    expect(res.body.eu_ai_act_compliant).toBe(true);
  });

  it('includes service name', async () => {
    const res = await request(app).get('/health');
    expect(res.body.service).toBe('realsync-backend');
  });

  it('includes uptime_s as number', async () => {
    const res = await request(app).get('/health');
    expect(typeof res.body.uptime_s).toBe('number');
    expect(res.body.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it('includes ISO timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ── GET /health/ready (readiness) ─────────────────────────────────────────────

describe('GET /health/ready', () => {
  it('returns 200 when DB is healthy', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  it('contains checks.database.status ok', async () => {
    const res = await request(app).get('/health/ready');
    expect(res.body.checks).toBeDefined();
    expect(res.body.checks.database.status).toBe('ok');
  });

  it('returns 503 when DB is down', async () => {
    const pool = require('../db');
    pool.query.mockRejectedValueOnce(new Error('Connection refused'));

    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
  });
});

// ── GET /health/deep (diagnostics — auth guard) ───────────────────────────────

describe('GET /health/deep', () => {
  it('returns 401 without X-Internal-Key', async () => {
    const res = await request(app).get('/health/deep');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong X-Internal-Key', async () => {
    const res = await request(app)
      .get('/health/deep')
      .set('X-Internal-Key', 'wrong_key');
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct X-Internal-Key', async () => {
    const res = await request(app)
      .get('/health/deep')
      .set('X-Internal-Key', 'test_health_key_secret');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('includes memory stats', async () => {
    const res = await request(app)
      .get('/health/deep')
      .set('X-Internal-Key', 'test_health_key_secret');
    expect(res.body.memory).toBeDefined();
    expect(typeof res.body.memory.rss_mb).toBe('number');
  });

  it('includes env_vars_set array', async () => {
    const res = await request(app)
      .get('/health/deep')
      .set('X-Internal-Key', 'test_health_key_secret');
    expect(Array.isArray(res.body.env_vars_set)).toBe(true);
  });
});
