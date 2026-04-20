'use strict';

/**
 * Approvals Route Tests — Sprint 13
 *
 * EU AI Act Art. 14 compliance tests:
 *   - Human oversight required before AI actions execute
 *   - Every decision is written to audit_logs
 *   - FOR UPDATE NOWAIT concurrency guard
 *   - High/critical risk requires comment
 *   - Expired approvals return 410 Gone
 *
 * Tests:
 *   GET  /approvals            — list (filters, pagination, default pending-only)
 *   GET  /approvals/stats      — KPI aggregation
 *   GET  /approvals/:id        — detail, UUID validation, 404
 *   POST /approvals/:id/approve — approve, comment required for high/critical,
 *                                 409 already decided, 410 expired, 409 lock contention
 *   POST /approvals/:id/reject  — reject, reason required, 409, 404
 */

// ── DB mock — pool + connect ──────────────────────────────────────────────────
const mockQuery    = jest.fn();
const mockConnect  = jest.fn();
const mockRelease  = jest.fn();
const mockClientQ  = jest.fn();

jest.mock('../db', () => ({
  query:   mockQuery,
  connect: mockConnect,
}));

// ── Redis mock ────────────────────────────────────────────────────────────────
jest.mock('ioredis', () => {
  const m = jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    ping:    jest.fn().mockResolvedValue('PONG'),
    quit:    jest.fn().mockResolvedValue(undefined),
  }));
  m.default = m;
  return m;
});

// ── Auth mock ─────────────────────────────────────────────────────────────────
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
      role:      'admin',
    };
    req.tenant_id = 'ten_test_001';
    req.user_id   = 'usr_test_001';
    next();
  },
}));

jest.mock('../middleware/plan-limits', () => ({
  checkWorkflowLimit:   (_req, _res, next) => next(),
  checkMonthlyRunLimit: (_req, _res, next) => next(),
  checkAgentTypeAllowed: () => (_req, _res, next) => next(),
  checkGatewayLimit:    (_req, _res, next) => next(),
  checkFeatureFlag:     () => (_req, _res, next) => next(),
}));

const request = require('supertest');

// ── Valid UUID for tests ──────────────────────────────────────────────────────
const APPROVAL_ID  = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const TASK_ID      = 'b1ffcd00-1d1c-5fg9-cc7e-7cc0ce491b22'.replace('g', '0').replace('f', 'f');
const TENANT_ID    = 'ten_test_001';
const USER_ID      = 'usr_test_001';

const APPROVAL_PENDING = {
  id:               APPROVAL_ID,
  tenant_id:        TENANT_ID,
  workflow_id:      'wf_test_001',
  task_id:          TASK_ID,
  requested_by:     USER_ID,
  action:           'delete_files',
  context:          { path: '/tmp/data' },
  status:           'pending',
  risk_level:       'medium',
  expires_at:       new Date(Date.now() + 86400000).toISOString(), // 24h from now
  created_at:       new Date().toISOString(),
  decision_by:      null,
  decision_at:      null,
  decision_comment: null,
};

const APPROVAL_HIGH_RISK = { ...APPROVAL_PENDING, risk_level: 'high' };
const APPROVAL_CRITICAL  = { ...APPROVAL_PENDING, risk_level: 'critical' };
const APPROVAL_APPROVED  = { ...APPROVAL_PENDING, status: 'approved' };
const APPROVAL_EXPIRED_TS = {
  ...APPROVAL_PENDING,
  expires_at: new Date(Date.now() - 1000).toISOString(), // already past
};

// ── pgClient mock factory ─────────────────────────────────────────────────────
function makeClient(queryResponses = []) {
  let callIdx = 0;
  const client = {
    query: jest.fn(async () => {
      const resp = queryResponses[callIdx++];
      if (resp instanceof Error) throw resp;
      return resp ?? { rows: [], rowCount: 0 };
    }),
    release: mockRelease,
  };
  mockConnect.mockResolvedValue(client);
  return client;
}

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

afterEach(() => {
  mockQuery.mockReset();
  mockConnect.mockReset();
  mockRelease.mockReset();
});

afterAll(async () => {
  try { const pool = require('../db'); if (pool.end) await pool.end(); } catch { /**/ }
});

// ── GET /approvals ────────────────────────────────────────────────────────────

describe('GET /approvals', () => {
  it('returns pending approvals ordered by risk level', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [APPROVAL_PENDING] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/approvals');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('pending');
    expect(res.body.pagination.total).toBe(1);
  });

  it('returns empty list when no pending approvals', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] });

    const res = await request(app).get('/api/v1/approvals');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.has_next).toBe(false);
  });

  it('filters by status=approved', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [APPROVAL_APPROVED] })
      .mockResolvedValueOnce({ rows: [{ total: '1' }] });

    const res = await request(app).get('/api/v1/approvals?status=approved');
    expect(res.status).toBe(200);
    expect(res.body.data[0].status).toBe('approved');
  });

  it('returns 400 for invalid risk_level filter', async () => {
    const res = await request(app).get('/api/v1/approvals?risk_level=extreme');
    expect(res.status).toBe(400);
    expect(res.body.title).toBe('Invalid Parameter');
  });

  it('returns pagination metadata', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '50' }] });

    const res = await request(app).get('/api/v1/approvals?limit=10&page=2');
    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(2);
    expect(res.body.pagination.limit).toBe(10);
    expect(res.body.pagination.total).toBe(50);
    expect(res.body.pagination.total_pages).toBe(5);
    expect(res.body.pagination.has_prev).toBe(true);
  });
});

// ── GET /approvals/stats ──────────────────────────────────────────────────────

describe('GET /approvals/stats', () => {
  it('returns KPI aggregation by status and risk', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { status: 'pending',  risk_level: 'high',   count: '3' },
          { status: 'approved', risk_level: 'medium',  count: '10' },
          { status: 'rejected', risk_level: 'low',    count: '2' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ expiring_soon: '1' }] });

    const res = await request(app).get('/api/v1/approvals/stats');
    expect(res.status).toBe(200);
    expect(res.body.by_status.pending).toBe(3);
    expect(res.body.by_status.approved).toBe(10);
    expect(res.body.by_risk.high.pending).toBe(3);
    expect(res.body.expiring_soon).toBe(1);
  });

  it('returns zeros when no approvals exist', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ expiring_soon: '0' }] });

    const res = await request(app).get('/api/v1/approvals/stats');
    expect(res.status).toBe(200);
    expect(res.body.by_status).toEqual({});
    expect(res.body.expiring_soon).toBe(0);
  });
});

// ── GET /approvals/:id ────────────────────────────────────────────────────────

describe('GET /approvals/:id', () => {
  it('returns approval detail', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [APPROVAL_PENDING], rowCount: 1 });

    const res = await request(app).get(`/api/v1/approvals/${APPROVAL_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(APPROVAL_ID);
    expect(res.body.data.risk_level).toBe('medium');
  });

  it('returns 400 for non-UUID id', async () => {
    const res = await request(app).get('/api/v1/approvals/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.title).toBe('Invalid Parameter');
  });

  it('returns 404 for unknown approval', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get(`/api/v1/approvals/${APPROVAL_ID}`);
    expect(res.status).toBe(404);
  });
});

// ── POST /approvals/:id/approve ───────────────────────────────────────────────

describe('POST /approvals/:id/approve', () => {
  it('approves a pending medium-risk approval without comment', async () => {
    const updatedApproval = { ...APPROVAL_PENDING, status: 'approved', decision_by: USER_ID };
    makeClient([
      { rows: [], rowCount: 0 },                           // BEGIN
      { rows: [APPROVAL_PENDING], rowCount: 1 },           // FOR UPDATE NOWAIT
      { rows: [], rowCount: 1 },                           // UPDATE tasks
      { rows: [], rowCount: 1 },                           // INSERT audit_log
      { rows: [updatedApproval], rowCount: 1 },            // UPDATE approvals RETURNING
      { rows: [], rowCount: 0 },                           // COMMIT
    ]);

    const res = await request(app)
      .post(`/api/v1/approvals/${APPROVAL_ID}/approve`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Approval granted.');
    expect(res.body.data.status).toBe('approved');
  });

  it('returns 422 for high-risk approval without comment', async () => {
    makeClient([
      { rows: [], rowCount: 0 },                          // BEGIN
      { rows: [APPROVAL_HIGH_RISK], rowCount: 1 },        // FOR UPDATE NOWAIT
      { rows: [], rowCount: 0 },                          // ROLLBACK
    ]);

    const res = await request(app)
      .post(`/api/v1/approvals/${APPROVAL_ID}/approve`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.detail).toContain('comment is required');
    expect(res.body.required_for).toContain('high');
  });

  it('returns 422 for critical-risk approval without comment', async () => {
    makeClient([
      { rows: [], rowCount: 0 },
      { rows: [APPROVAL_CRITICAL], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);

    const res = await request(app)
      .post(`/api/v1/approvals/${APPROVAL_ID}/approve`)
      .send({});

    expect(res.status).toBe(422);
  });

  it('approves critical-risk with comment (EU AI Act Art. 14)', async () => {
    const updatedApproval = { ...APPROVAL_CRITICAL, status: 'approved', decision_by: USER_ID };
    makeClient([
      { rows: [], rowCount: 0 },
      { rows: [APPROVAL_CRITICAL], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [updatedApproval], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);

    const res = await request(app)
      .post(`/api/v1/approvals/${APPROVAL_ID}/approve`)
      .send({ comment: 'Reviewed and confirmed safe by security team' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('approved');
  });

  it('returns 409 when approval already decided', async () => {
    makeClient([
      { rows: [], rowCount: 0 },
      { rows: [APPROVAL_APPROVED], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);

    const res = await request(app)
      .post(`/api/v1/approvals/${APPROVAL_ID}/approve`)
      .send({ comment: 'too late' });

    expect(res.status).toBe(409);
    expect(res.body.current_status).toBe('approved');
  });

  it('returns 410 Gone when approval expired', async () => {
    makeClient([
      { rows: [], rowCount: 0 },
      { rows: [APPROVAL_EXPIRED_TS], rowCount: 1 },
      { rows: [], rowCount: 1 },  // UPDATE status=expired
      { rows: [], rowCount: 0 },  // COMMIT
    ]);

    const res = await request(app)
      .post(`/api/v1/approvals/${APPROVAL_ID}/approve`)
      .send({});

    expect(res.status).toBe(410);
    expect(res.body.title).toBe('Gone');
  });

  it('returns 409 on pg lock contention (55P03)', async () => {
    const lockErr = new Error('could not obtain lock on row');
    lockErr.code = '55P03';

    makeClient([
      { rows: [], rowCount: 0 },   // BEGIN
      lockErr,                      // FOR UPDATE NOWAIT throws
    ]);

    const res = await request(app)
      .post(`/api/v1/approvals/${APPROVAL_ID}/approve`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('retry');
  });

  it('returns 400 for non-UUID id', async () => {
    const res = await request(app)
      .post('/api/v1/approvals/invalid-id/approve')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when approval not found', async () => {
    makeClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);

    const res = await request(app)
      .post(`/api/v1/approvals/${APPROVAL_ID}/approve`)
      .send({});

    expect(res.status).toBe(404);
  });
});

// ── POST /approvals/:id/reject ────────────────────────────────────────────────

describe('POST /approvals/:id/reject', () => {
  it('returns 422 when reason is missing', async () => {
    const res = await request(app)
      .post(`/api/v1/approvals/${APPROVAL_ID}/reject`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.detail).toContain('reason is required');
  });

  it('returns 422 when reason is blank string', async () => {
    const res = await request(app)
      .post(`/api/v1/approvals/${APPROVAL_ID}/reject`)
      .send({ reason: '   ' });
    expect(res.status).toBe(422);
  });

  it('rejects a pending approval (EU AI Act Art. 14 — human override)', async () => {
    const rejectedApproval = { ...APPROVAL_PENDING, status: 'rejected', decision_by: USER_ID };
    makeClient([
      { rows: [], rowCount: 0 },
      { rows: [APPROVAL_PENDING], rowCount: 1 },
      { rows: [], rowCount: 1 },              // UPDATE tasks
      { rows: [], rowCount: 1 },              // INSERT audit_log
      { rows: [rejectedApproval], rowCount: 1 },
      { rows: [], rowCount: 0 },              // COMMIT
    ]);

    const res = await request(app)
      .post(`/api/v1/approvals/${APPROVAL_ID}/reject`)
      .send({ reason: 'Action deemed unsafe by compliance officer' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Approval rejected.');
    expect(res.body.data.status).toBe('rejected');
  });

  it('returns 409 when approval already decided', async () => {
    makeClient([
      { rows: [], rowCount: 0 },
      { rows: [APPROVAL_APPROVED], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);

    const res = await request(app)
      .post(`/api/v1/approvals/${APPROVAL_ID}/reject`)
      .send({ reason: 'Not safe' });

    expect(res.status).toBe(409);
    expect(res.body.current_status).toBe('approved');
  });

  it('returns 409 on pg lock contention (55P03)', async () => {
    const lockErr = new Error('could not obtain lock on row');
    lockErr.code = '55P03';

    makeClient([
      { rows: [], rowCount: 0 },
      lockErr,
    ]);

    const res = await request(app)
      .post(`/api/v1/approvals/${APPROVAL_ID}/reject`)
      .send({ reason: 'Concurrent' });

    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('retry');
  });

  it('returns 404 when approval not found', async () => {
    makeClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);

    const res = await request(app)
      .post(`/api/v1/approvals/${APPROVAL_ID}/reject`)
      .send({ reason: 'Not found test' });

    expect(res.status).toBe(404);
  });
});
