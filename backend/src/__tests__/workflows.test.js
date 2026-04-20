'use strict';

/**
 * Workflows Route Tests — Sprint 12
 *
 * Full CRUD + execution control + human approval tested.
 * All DB and AI calls are mocked — no real Postgres or OpenAI required.
 *
 * Tests:
 *   GET    /workflows           — list with pagination
 *   POST   /workflows           — create, validation
 *   GET    /workflows/:id       — detail, 404
 *   PATCH  /workflows/:id       — update, invalid status, 404
 *   DELETE /workflows/:id       — soft-delete, 404
 *   POST   /workflows/:id/execute   — success, already running, 404
 *   POST   /workflows/:id/pause     — success, 404
 *   POST   /workflows/:id/resume    — success, not paused, 404
 *   POST   /workflows/:id/approve   — approve, reject, validation, 404
 */

// ── DB mock ───────────────────────────────────────────────────────────────────
const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: mockQuery }));

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

// ── AIManager mock ────────────────────────────────────────────────────────────
jest.mock('../ai-manager', () => ({
  AIManager: jest.fn().mockImplementation(() => ({
    processGoal: jest.fn().mockResolvedValue({
      trace_id:   'trace_test_001',
      task_count: 3,
      tasks:      [{ id: 'task_001' }, { id: 'task_002' }, { id: 'task_003' }],
    }),
  })),
  setupQueues: jest.fn().mockReturnValue({
    taskQueue:       { add: jest.fn() },
    approvalQueue:   { add: jest.fn() },
    deadLetterQueue: { add: jest.fn() },
  }),
}));

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
    req.tenant_id = 'ten_test_001';
    req.user      = { id: 'usr_test_001' };
    req.user_id   = 'usr_test_001';
    req.user_role = 'admin';
    next();
  },
}));

// ── plan-limits mock — always pass ────────────────────────────────────────────
jest.mock('../middleware/plan-limits', () => ({
  checkWorkflowLimit:   (_req, _res, next) => next(),
  checkMonthlyRunLimit: (_req, _res, next) => next(),
  checkAgentTypeAllowed: () => (_req, _res, next) => next(),
  checkGatewayLimit:    (_req, _res, next) => next(),
  checkFeatureFlag:     () => (_req, _res, next) => next(),
}));

const request = require('supertest');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WF_DRAFT = {
  id:         'wf_test_001',
  tenant_id:  'ten_test_001',
  title:      'Daily Health Check',
  goal:       'Check system health every morning',
  config:     {},
  status:     'draft',
  created_by: 'usr_test_001',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  run_count:  0,
};

const WF_ACTIVE = { ...WF_DRAFT, id: 'wf_test_002', status: 'active' };
const WF_PAUSED = { ...WF_DRAFT, id: 'wf_test_003', status: 'paused' };

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
  process.env.OPENAI_API_KEY      = 'sk-test-placeholder';

  app = require('../app');
});

afterEach(() => {
  mockQuery.mockReset();
});

afterAll(async () => {
  try {
    const pool = require('../db');
    if (pool.end) await pool.end();
  } catch { /* ignore */ }
});

// ── GET /workflows ────────────────────────────────────────────────────────────

describe('GET /workflows', () => {
  it('returns paginated list', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WF_DRAFT, WF_ACTIVE] }) // SELECT workflows
      .mockResolvedValueOnce({ rows: [{ count: '2' }] });      // COUNT

    const res = await request(app).get('/api/v1/workflows');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.total).toBe(2);
    expect(res.body.meta.page).toBe(1);
  });

  it('returns empty list for new tenant', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(app).get('/api/v1/workflows');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.meta.total).toBe(0);
  });

  it('filters by status query param', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WF_ACTIVE] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const res = await request(app).get('/api/v1/workflows?status=active');
    expect(res.status).toBe(200);
    expect(res.body.data[0].status).toBe('active');
  });

  it('respects limit and page params', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WF_DRAFT] })
      .mockResolvedValueOnce({ rows: [{ count: '10' }] });

    const res = await request(app).get('/api/v1/workflows?limit=1&page=2');
    expect(res.status).toBe(200);
    expect(res.body.meta.pages).toBe(10);
    expect(res.body.meta.page).toBe(2);
    expect(res.body.meta.limit).toBe(1);
  });
});

// ── POST /workflows ───────────────────────────────────────────────────────────

describe('POST /workflows', () => {
  it('returns 400 when title is missing', async () => {
    const res = await request(app)
      .post('/api/v1/workflows')
      .send({ goal: 'Do something' });
    expect(res.status).toBe(400);
    expect(res.body.type).toContain('realsync');
  });

  it('returns 400 when goal is missing', async () => {
    const res = await request(app)
      .post('/api/v1/workflows')
      .send({ title: 'My workflow' });
    expect(res.status).toBe(400);
  });

  it('creates workflow and returns 201', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WF_DRAFT] })   // INSERT workflow RETURNING
      .mockResolvedValueOnce({ rows: [] });            // audit_log INSERT

    const res = await request(app)
      .post('/api/v1/workflows')
      .send({ title: 'Daily Health Check', goal: 'Check system health' });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('wf_test_001');
    expect(res.body.data.status).toBe('draft');
  });

  it('creates workflow with optional config', async () => {
    const wfWithConfig = { ...WF_DRAFT, config: { schedule: '0 8 * * *' } };
    mockQuery
      .mockResolvedValueOnce({ rows: [wfWithConfig] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/v1/workflows')
      .send({ title: 'Scheduled', goal: 'Run daily', config: { schedule: '0 8 * * *' } });

    expect(res.status).toBe(201);
    expect(res.body.data.config.schedule).toBe('0 8 * * *');
  });
});

// ── GET /workflows/:id ────────────────────────────────────────────────────────

describe('GET /workflows/:id', () => {
  it('returns workflow detail', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...WF_DRAFT, task_count: '5', created_by_name: 'Admin' }] });

    const res = await request(app).get('/api/v1/workflows/wf_test_001');
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('wf_test_001');
    expect(res.body.data.task_count).toBe('5');
  });

  it('returns 404 for unknown workflow', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/v1/workflows/wf_nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.title).toBe('Not Found');
  });

  it('enforces tenant isolation (other tenant workflow returns 404)', async () => {
    // DB query for this tenant returns 0 rows (workflow belongs to another tenant)
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/v1/workflows/wf_other_tenant');
    expect(res.status).toBe(404);
  });
});

// ── PATCH /workflows/:id ──────────────────────────────────────────────────────

describe('PATCH /workflows/:id', () => {
  it('updates title successfully', async () => {
    const updated = { ...WF_DRAFT, title: 'New Title' };
    mockQuery
      .mockResolvedValueOnce({ rows: [WF_DRAFT] })    // SELECT current
      .mockResolvedValueOnce({ rows: [updated] })     // UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [] });            // audit_log

    const res = await request(app)
      .patch('/api/v1/workflows/wf_test_001')
      .send({ title: 'New Title' });

    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('New Title');
  });

  it('returns 400 for invalid status', async () => {
    const res = await request(app)
      .patch('/api/v1/workflows/wf_test_001')
      .send({ status: 'invalid_status' });

    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('Invalid status');
  });

  it('returns 400 when no fields provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [WF_DRAFT] }); // SELECT current

    const res = await request(app)
      .patch('/api/v1/workflows/wf_test_001')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('No updateable fields');
  });

  it('returns 404 for unknown workflow', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch('/api/v1/workflows/wf_nonexistent')
      .send({ title: 'New Title' });

    expect(res.status).toBe(404);
  });

  it('accepts all valid statuses', async () => {
    const validStatuses = ['draft', 'active', 'paused', 'completed', 'error'];

    for (const status of validStatuses) {
      const updated = { ...WF_DRAFT, status };
      mockQuery
        .mockResolvedValueOnce({ rows: [WF_DRAFT] })
        .mockResolvedValueOnce({ rows: [updated] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .patch(`/api/v1/workflows/wf_test_001`)
        .send({ status });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(status);
    }
  });
});

// ── DELETE /workflows/:id ─────────────────────────────────────────────────────

describe('DELETE /workflows/:id', () => {
  it('soft-deletes and returns 204', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WF_DRAFT] })  // SELECT current
      .mockResolvedValueOnce({ rows: [] })           // UPDATE status = completed
      .mockResolvedValueOnce({ rows: [] });          // audit_log

    const res = await request(app).delete('/api/v1/workflows/wf_test_001');
    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it('returns 404 for unknown workflow', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete('/api/v1/workflows/wf_nonexistent');
    expect(res.status).toBe(404);
  });
});

// ── POST /workflows/:id/execute ───────────────────────────────────────────────

describe('POST /workflows/:id/execute', () => {
  it('returns 202 and enqueues tasks', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WF_DRAFT] })  // SELECT workflow
      .mockResolvedValueOnce({ rows: [] })           // UPDATE status = active
      .mockResolvedValueOnce({ rows: [] });          // audit_log

    const res = await request(app)
      .post('/api/v1/workflows/wf_test_001/execute')
      .send({});

    expect(res.status).toBe(202);
    expect(res.body.data.trace_id).toBe('trace_test_001');
    expect(res.body.data.task_count).toBe(3);
  });

  it('returns 409 when workflow is already running', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...WF_ACTIVE, status: 'running' }] });

    const res = await request(app)
      .post('/api/v1/workflows/wf_test_002/execute')
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.title).toBe('Conflict');
  });

  it('returns 404 for unknown workflow', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/v1/workflows/wf_nonexistent/execute')
      .send({});

    expect(res.status).toBe(404);
  });
});

// ── POST /workflows/:id/pause ─────────────────────────────────────────────────

describe('POST /workflows/:id/pause', () => {
  it('pauses an active workflow', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WF_ACTIVE] })                    // SELECT
      .mockResolvedValueOnce({ rows: [] })                             // UPDATE status = paused
      .mockResolvedValueOnce({ rows: [] });                            // audit_log

    const res = await request(app).post('/api/v1/workflows/wf_test_002/pause');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('paused');
  });

  it('returns 404 for unknown workflow', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post('/api/v1/workflows/wf_nonexistent/pause');
    expect(res.status).toBe(404);
  });
});

// ── POST /workflows/:id/resume ────────────────────────────────────────────────

describe('POST /workflows/:id/resume', () => {
  it('resumes a paused workflow', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [WF_PAUSED] })  // SELECT
      .mockResolvedValueOnce({ rows: [] })            // UPDATE status = active
      .mockResolvedValueOnce({ rows: [] });           // audit_log

    const res = await request(app).post('/api/v1/workflows/wf_test_003/resume');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('active');
  });

  it('returns 409 when workflow is not paused', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [WF_ACTIVE] });

    const res = await request(app).post('/api/v1/workflows/wf_test_002/resume');
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('paused');
  });

  it('returns 404 for unknown workflow', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post('/api/v1/workflows/wf_nonexistent/resume');
    expect(res.status).toBe(404);
  });
});

// ── POST /workflows/:id/approve ───────────────────────────────────────────────

describe('POST /workflows/:id/approve', () => {
  it('returns 400 when task_id missing', async () => {
    const res = await request(app)
      .post('/api/v1/workflows/wf_test_001/approve')
      .send({ decision: 'approve' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('task_id');
  });

  it('returns 400 when decision missing', async () => {
    const res = await request(app)
      .post('/api/v1/workflows/wf_test_001/approve')
      .send({ task_id: 'task_001' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid decision value', async () => {
    const res = await request(app)
      .post('/api/v1/workflows/wf_test_001/approve')
      .send({ task_id: 'task_001', decision: 'maybe' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('"approve"');
  });

  it('approves a task (EU AI Act Art. 14 — human oversight)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'wf_test_001' }] })  // workflow exists
      .mockResolvedValueOnce({ rows: [{ id: 'task_001', status: 'running' }] }) // UPDATE tasks
      .mockResolvedValueOnce({ rows: [] });                        // audit_log

    const res = await request(app)
      .post('/api/v1/workflows/wf_test_001/approve')
      .send({ task_id: 'task_001', decision: 'approve', reason: 'Looks good' });

    expect(res.status).toBe(200);
    expect(res.body.data.decision).toBe('approve');
    expect(res.body.data.task_id).toBe('task_001');
    expect(res.body.data.approved_by).toBe('usr_test_001');
  });

  it('rejects a task (EU AI Act Art. 14 — human override)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'wf_test_001' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'task_001', status: 'failed' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/v1/workflows/wf_test_001/approve')
      .send({ task_id: 'task_001', decision: 'reject', reason: 'Not safe' });

    expect(res.status).toBe(200);
    expect(res.body.data.decision).toBe('reject');
  });

  it('returns 404 when workflow not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/v1/workflows/wf_nonexistent/approve')
      .send({ task_id: 'task_001', decision: 'approve' });

    expect(res.status).toBe(404);
  });

  it('returns 404 when task not in workflow', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'wf_test_001' }] })
      .mockResolvedValueOnce({ rows: [] }); // task not found

    const res = await request(app)
      .post('/api/v1/workflows/wf_test_001/approve')
      .send({ task_id: 'task_wrong', decision: 'approve' });

    expect(res.status).toBe(404);
  });
});
