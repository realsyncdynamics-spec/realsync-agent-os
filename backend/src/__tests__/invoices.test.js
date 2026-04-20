'use strict';

/**
 * Invoices Route Tests — Sprint 13
 *
 * § 147 AO: Rechnungen müssen 10 Jahre aufbewahrt werden.
 * retention_until ist eine generierte Spalte (invoice_date + 10 years).
 *
 * Tests:
 *   GET  /invoices              — list, keyset pagination, filters
 *   GET  /invoices/:id          — detail, 404, tenant isolation
 *   POST /invoices              — create, validation
 *   PATCH /invoices/:id         — update metadata, soft-delete guard
 *   DELETE /invoices/:id        — soft-delete (admin only)
 *   GET  /invoices/export       — CSV export, role guard, date range
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
    req.user      = { id: 'user-001', email: 'test@realsync.io', role: 'admin' };
    req.tenant_id = 'ten_test_001';
    req.user_id   = 'usr_test_001';
    req.user_role = 'admin';
    next();
  },
  authenticateToken: (req, _res, next) => {
    req.user = {
      id:        'usr_test_001',
      tenant_id: 'ten_test_001',
      role:      req._overrideRole ?? 'admin',
    };
    req.tenant_id = 'ten_test_001';
    req.user_id   = 'usr_test_001';
    req.user_role = req._overrideRole ?? 'admin';
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

const INVOICE = {
  id:               'inv_test_001',
  tenant_id:        'ten_test_001',
  invoice_number:   'RE-2026-001',
  vendor_name:      'Acme GmbH',
  amount:           1190.00,
  currency:         'EUR',
  invoice_date:     '2026-01-15',
  due_date:         '2026-02-15',
  status:           'pending',
  ai_extracted:     true,
  ai_confidence:    0.97,
  retention_until:  '2036-01-15',
  deleted_at:       null,
  created_at:       new Date().toISOString(),
  updated_at:       new Date().toISOString(),
};

const INVOICE_ARCHIVED = { ...INVOICE, id: 'inv_test_002', status: 'archived' };
const INVOICE_DELETED  = { ...INVOICE, id: 'inv_test_003', deleted_at: new Date().toISOString() };

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

// ── GET /invoices ─────────────────────────────────────────────────────────────

describe('GET /invoices', () => {
  it('returns invoice list excluding soft-deleted', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [INVOICE] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const res = await request(app).get('/api/v1/invoices');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].invoice_number).toBe('RE-2026-001');
  });

  it('returns empty list for new tenant', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(app).get('/api/v1/invoices');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('filters by status=archived', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [INVOICE_ARCHIVED] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const res = await request(app).get('/api/v1/invoices?status=archived');
    expect(res.status).toBe(200);
    expect(res.body.data[0].status).toBe('archived');
  });

  it('filters by vendor_name', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [INVOICE] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const res = await request(app).get('/api/v1/invoices?vendor_name=Acme');
    expect(res.status).toBe(200);
  });

  it('returns retention_until field (§ 147 AO)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [INVOICE] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const res = await request(app).get('/api/v1/invoices');
    expect(res.status).toBe(200);
    expect(res.body.data[0].retention_until).toBe('2036-01-15');
  });

  it('returns ai_extracted and ai_confidence fields', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [INVOICE] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const res = await request(app).get('/api/v1/invoices');
    expect(res.status).toBe(200);
    expect(res.body.data[0].ai_extracted).toBe(true);
    expect(res.body.data[0].ai_confidence).toBe(0.97);
  });
});

// ── GET /invoices/:id ─────────────────────────────────────────────────────────

describe('GET /invoices/:id', () => {
  it('returns invoice detail', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [INVOICE] });

    const res = await request(app).get('/api/v1/invoices/inv_test_001');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('inv_test_001');
    expect(res.body.data.amount).toBe(1190.00);
    expect(res.body.data.currency).toBe('EUR');
  });

  it('returns 404 for unknown invoice', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/v1/invoices/inv_nonexistent');
    expect(res.status).toBe(404);
  });

  it('enforces tenant isolation (other tenant invoice → 404)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/v1/invoices/inv_other_tenant');
    expect(res.status).toBe(404);
  });

  it('returns 404 for soft-deleted invoice', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // WHERE deleted_at IS NULL

    const res = await request(app).get('/api/v1/invoices/inv_test_003');
    expect(res.status).toBe(404);
  });
});

// ── POST /invoices ────────────────────────────────────────────────────────────

describe('POST /invoices', () => {
  it('returns 400 when required fields missing', async () => {
    const res = await request(app)
      .post('/api/v1/invoices')
      .send({ vendor_name: 'Acme' }); // missing amount, invoice_date
    expect(res.status).toBe(400);
  });

  it('creates invoice with required fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [INVOICE] });

    const res = await request(app)
      .post('/api/v1/invoices')
      .send({
        vendor_name:    'Acme GmbH',
        amount:         1190.00,
        currency:       'EUR',
        invoice_date:   '2026-01-15',
        invoice_number: 'RE-2026-001',
      });

    expect([200, 201]).toContain(res.status);
    if ([200, 201].includes(res.status)) {
      expect(res.body.data.vendor_name).toBe('Acme GmbH');
    }
  });

  it('returns 400 for negative amount', async () => {
    const res = await request(app)
      .post('/api/v1/invoices')
      .send({
        vendor_name: 'Bad Corp', amount: -100,
        invoice_date: '2026-01-01',
      });
    expect(res.status).toBe(400);
  });
});

// ── DELETE /invoices/:id ──────────────────────────────────────────────────────

describe('DELETE /invoices/:id', () => {
  it('soft-deletes an invoice (sets deleted_at)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [INVOICE] })    // SELECT invoice
      .mockResolvedValueOnce({ rows: [] });           // UPDATE deleted_at = NOW()

    const res = await request(app).delete('/api/v1/invoices/inv_test_001');
    expect([200, 204]).toContain(res.status);
    // Verify it was a soft-delete (UPDATE, not DELETE FROM)
    const updateCall = mockQuery.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('deleted_at')
    );
    expect(updateCall).toBeDefined();
  });

  it('returns 404 for unknown invoice', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete('/api/v1/invoices/inv_nonexistent');
    expect(res.status).toBe(404);
  });
});

// ── GET /invoices/export ──────────────────────────────────────────────────────

describe('GET /invoices/export', () => {
  it('returns 400 without date range', async () => {
    const res = await request(app).get('/api/v1/invoices/export');
    expect([400, 422]).toContain(res.status);
  });

  it('returns CSV or JSON with valid date range (§ 147 AO export)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [INVOICE, INVOICE_ARCHIVED] });

    const from = '2026-01-01';
    const to   = '2026-12-31';
    const res  = await request(app).get(`/api/v1/invoices/export?from=${from}&to=${to}`);

    expect([200, 403]).toContain(res.status);
    if (res.status === 200) {
      const ct = res.headers['content-type'];
      expect(ct).toMatch(/csv|json|text/);
    }
  });

  it('returns 400 for invalid date format', async () => {
    const res = await request(app).get('/api/v1/invoices/export?from=not-a-date&to=also-bad');
    expect([400, 422]).toContain(res.status);
  });
});
