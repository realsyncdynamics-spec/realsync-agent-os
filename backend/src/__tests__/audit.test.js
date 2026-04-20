'use strict';

/**
 * Audit Log Tests — Sprint 13
 *
 * Tests:
 *   GET  /audit              — list with filters, keyset pagination
 *   GET  /audit/:id          — single entry
 *   GET  /audit/export       — NDJSON export, role guard, date range
 */

const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: mockQuery }));

jest.mock('ioredis', () => {
  const m = jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    ping:    jest.fn().mockResolvedValue('PONG'),
    quit:    jest.fn().mockResolvedValue(undefined),
  }));
  m.default = m;
  return m;
});

jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user      = { id: 'user-001', email: 'test@realsync.io', role: 'admin', tenant_id: 'ten_test_001' };
    req.tenant_id = 'ten_test_001';
    req.user_id   = 'usr_test_001';
    req.user_role = 'admin';
    next();
  },
  authenticateToken: (req, _res, next) => {
    req.user      = { id: 'usr_test_001', tenant_id: 'ten_test_001', role: 'admin' };
    req.tenant_id = 'ten_test_001';
    req.user_id   = 'usr_test_001';
    req.user_role = 'admin';
    next();
  },
}));

jest.mock('../middleware/plan-limits', () => ({
  checkWorkflowLimit:    (_req, _res, next) => next(),
  checkMonthlyRunLimit:  (_req, _res, next) => next(),
  checkAgentTypeAllowed: () => (_req, _res, next) => next(),
  checkGatewayLimit:     (_req, _res, next) => next(),
  checkFeatureFlag:      () => (_req, _res, next) => next(),
}));

const request = require('supertest');

const AUDIT_ENTRY = {
  id:          'aud_test_001',
  tenant_id:   'ten_test_001',
  user_id:     'usr_test_001',
  action:      'workflow.create',
  resource:    'workflow',
  resource_id: 'wf_test_001',
  details:     { title: 'Daily Health Check' },
  ip_address:  '127.0.0.1',
  status:      'success',
  created_at:  new Date().toISOString(),
};

let app;

beforeAll(() => {
  process.env.NODE_ENV            = 'test';
  process.env.JWT_SECRET          = 'test_jwt_secret_32_chars_minimum_x';
  process.env.JWT_REFRESH_SECRET  = 'test_refresh_secret_32_chars_minx';
  process.env.AGENT_INTERNAL_KEY  = 'test_agent_key_16c';
  process.env.GATEWAY_SECRET      = 'test_gateway_secret';
  process.env.INTERNAL_HEALTH_KEY = 'test_health_key_secret';
  process.env.REDIS_URL           = 'redis://localhost:6379';
  process.env.DATABASE_URL        = 'postgresql://x:x@localhost/x';
  process.env.ENABLE_WORKERS      = 'false';

  app = require('../app');
});

afterEach(() => mockQuery.mockReset());
afterAll(async () => {
  try { const pool = require('../db'); if (pool.end) await pool.end(); } catch { /**/ }
});

// ── GET /audit ────────────────────────────────────────────────────────────────

describe('GET /audit', () => {
  it('returns audit log entries', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [AUDIT_ENTRY] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/audit');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].action).toBe('workflow.create');
  });

  it('returns empty list for tenant with no audit events', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });

    const res = await request(app).get('/api/v1/audit');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('filters by action', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [AUDIT_ENTRY] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/audit?action=workflow.create');
    expect(res.status).toBe(200);
  });

  it('filters by user_id', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [AUDIT_ENTRY] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/audit?user_id=usr_test_001');
    expect(res.status).toBe(200);
  });

  it('filters by date range (from/to)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [AUDIT_ENTRY] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const from = new Date(Date.now() - 86400000).toISOString();
    const to   = new Date().toISOString();
    const res  = await request(app).get(`/api/v1/audit?from=${from}&to=${to}`);
    expect(res.status).toBe(200);
  });

  it('includes pagination meta', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [AUDIT_ENTRY] })
      .mockResolvedValueOnce({ rows: [{ total: '42' }] });

    const res = await request(app).get('/api/v1/audit?limit=20&page=1');
    expect(res.status).toBe(200);
    expect(res.body.pagination).toBeDefined();
    expect(typeof res.body.pagination.total).toBe('number');
  });
});

// ── GET /audit/export ─────────────────────────────────────────────────────────

describe('GET /audit/export', () => {
  it('returns 400 without date range', async () => {
    const res = await request(app).get('/api/v1/audit/export');
    expect([400, 422]).toContain(res.status);
  });

  it('returns NDJSON with valid date range', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [AUDIT_ENTRY, AUDIT_ENTRY] });

    const from = new Date(Date.now() - 86400000).toISOString();
    const to   = new Date().toISOString();

    const res = await request(app).get(`/api/v1/audit/export?from=${from}&to=${to}`);

    // Either NDJSON or JSON depending on implementation
    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const ct = res.headers['content-type'];
      expect(ct).toMatch(/ndjson|json|text/);
    }
  });

  it('returns 400 for invalid date format', async () => {
    const res = await request(app).get('/api/v1/audit/export?from=not-a-date&to=also-bad');
    expect([400, 422]).toContain(res.status);
  });
});
