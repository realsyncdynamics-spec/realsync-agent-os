'use strict';

/**
 * Tasks Route Tests — Sprint 13
 *
 * Tests:
 *   GET  /workflows/:wfId/tasks    — list, pagination, tenant isolation
 *   GET  /tasks/:id                — detail, run_count, 404
 *   PATCH /tasks/:id               — status update, invalid transition, 404
 *   POST /tasks/:id/retry          — re-queue failed task, 409 if not failed
 *   GET  /tasks/:id/logs           — agent run log, pagination
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
    req.user      = { id: 'usr_test_001', tenant_id: 'ten_test_001', role: 'admin' };
    req.tenant_id = 'ten_test_001';
    req.user_id   = 'usr_test_001';
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

const WF_ID   = 'wf_test_001';
const TASK_ID = 'task_test_001';

const TASK_PENDING = {
  id:          TASK_ID,
  workflow_id: WF_ID,
  tenant_id:   'ten_test_001',
  title:       'Check server health',
  status:      'pending',
  priority:    1,
  agent_type:  'devops',
  input:       { target: 'prod-server-01' },
  output:      null,
  error:       null,
  run_count:   '0',
  created_at:  new Date().toISOString(),
  updated_at:  new Date().toISOString(),
};

const TASK_FAILED  = { ...TASK_PENDING, status: 'failed', error: 'Connection timeout' };
const TASK_RUNNING = { ...TASK_PENDING, status: 'running' };

const AGENT_RUN = {
  id:            'run_test_001',
  task_id:       TASK_ID,
  status:        'completed',
  output:        '{"health":"ok"}',
  started_at:    new Date().toISOString(),
  finished_at:   new Date().toISOString(),
  agent_version: '1.0.0',
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

// ── GET /workflows/:wfId/tasks ────────────────────────────────────────────────

describe('GET /workflows/:wfId/tasks', () => {
  it('returns task list for a valid workflow', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: WF_ID }] })         // tenant ownership check
      .mockResolvedValueOnce({ rows: [TASK_PENDING] })           // SELECT tasks
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });        // COUNT

    const res = await request(app).get(`/api/v1/workflows/${WF_ID}/tasks`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('pending');
    expect(res.body.meta.total).toBe(1);
  });

  it('returns 404 when workflow does not belong to tenant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // ownership check fails

    const res = await request(app).get('/api/v1/workflows/wf_other/tasks');
    expect(res.status).toBe(404);
    expect(res.body.title).toBe('Not Found');
  });

  it('returns empty list when workflow has no tasks', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: WF_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(app).get(`/api/v1/workflows/${WF_ID}/tasks`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.meta.pages).toBe(0);
  });

  it('respects limit and page params', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: WF_ID }] })
      .mockResolvedValueOnce({ rows: [TASK_PENDING] })
      .mockResolvedValueOnce({ rows: [{ count: '30' }] });

    const res = await request(app).get(`/api/v1/workflows/${WF_ID}/tasks?limit=1&page=3`);
    expect(res.status).toBe(200);
    expect(res.body.meta.page).toBe(3);
    expect(res.body.meta.limit).toBe(1);
    expect(res.body.meta.pages).toBe(30);
  });
});

// ── GET /tasks/:id ────────────────────────────────────────────────────────────

describe('GET /tasks/:id', () => {
  it('returns task detail with run_count', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...TASK_PENDING, run_count: '5' }] });

    const res = await request(app).get(`/api/v1/tasks/${TASK_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(TASK_ID);
    expect(res.body.data.run_count).toBe('5');
  });

  it('returns 404 for unknown task', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/v1/tasks/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.title).toBe('Not Found');
  });

  it('enforces tenant isolation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // other tenant's task not found

    const res = await request(app).get('/api/v1/tasks/task_other_tenant');
    expect(res.status).toBe(404);
  });
});

// ── PATCH /tasks/:id ──────────────────────────────────────────────────────────

describe('PATCH /tasks/:id', () => {
  it('updates task status to paused', async () => {
    const updated = { ...TASK_RUNNING, status: 'paused' };
    mockQuery
      .mockResolvedValueOnce({ rows: [TASK_RUNNING] })   // SELECT current
      .mockResolvedValueOnce({ rows: [updated] });        // UPDATE RETURNING

    const res = await request(app)
      .patch(`/api/v1/tasks/${TASK_ID}`)
      .send({ status: 'paused' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('paused');
  });

  it('returns 400 for invalid status value', async () => {
    const res = await request(app)
      .patch(`/api/v1/tasks/${TASK_ID}`)
      .send({ status: 'flying' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when no fields provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [TASK_PENDING] });

    const res = await request(app)
      .patch(`/api/v1/tasks/${TASK_ID}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown task', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch('/api/v1/tasks/nonexistent')
      .send({ status: 'paused' });

    expect(res.status).toBe(404);
  });
});

// ── POST /tasks/:id/retry ─────────────────────────────────────────────────────

describe('POST /tasks/:id/retry', () => {
  it('re-queues a failed task', async () => {
    const retried = { ...TASK_FAILED, status: 'pending', error: null };
    mockQuery
      .mockResolvedValueOnce({ rows: [TASK_FAILED] })    // SELECT task
      .mockResolvedValueOnce({ rows: [retried] });        // UPDATE status=pending RETURNING

    const res = await request(app).post(`/api/v1/tasks/${TASK_ID}/retry`);
    expect([200, 202]).toContain(res.status);
    expect(res.body.data.status).toBe('pending');
  });

  it('returns 409 when task is not in failed state', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [TASK_RUNNING] });

    const res = await request(app).post(`/api/v1/tasks/${TASK_ID}/retry`);
    expect(res.status).toBe(409);
    expect(res.body.title).toContain('Conflict');
  });

  it('returns 404 for unknown task', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post('/api/v1/tasks/nonexistent/retry');
    expect(res.status).toBe(404);
  });
});

// ── GET /tasks/:id/logs ───────────────────────────────────────────────────────

describe('GET /tasks/:id/logs', () => {
  it('returns agent run logs for a task', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [TASK_PENDING] })          // task ownership
      .mockResolvedValueOnce({ rows: [AGENT_RUN] })             // SELECT agent_runs
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });       // COUNT

    const res = await request(app).get(`/api/v1/tasks/${TASK_ID}/logs`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('run_test_001');
  });

  it('returns empty logs array for new task', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [TASK_PENDING] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(app).get(`/api/v1/tasks/${TASK_ID}/logs`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('returns 404 for unknown task', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/v1/tasks/nonexistent/logs');
    expect(res.status).toBe(404);
  });
});
