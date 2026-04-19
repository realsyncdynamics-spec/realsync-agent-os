'use strict';

/**
 * Plan-Limits Middleware Tests — Sprint 11
 *
 * Tests:
 *   checkWorkflowLimit    — blocks at limit, allows below, passes unlimited
 *   checkMonthlyRunLimit  — blocks at limit, sets response headers
 *   checkAgentTypeAllowed — blocks disallowed types, passes allowed
 *   checkGatewayLimit     — blocks at limit, passes unlimited
 *   checkFeatureFlag      — blocks disabled features, passes enabled
 */

const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: mockQuery }));

jest.mock('ioredis', () => {
  const mock = jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    ping:    jest.fn().mockResolvedValue('PONG'),
    quit:    jest.fn().mockResolvedValue(undefined),
  }));
  mock.default = mock;
  return mock;
});

const {
  checkWorkflowLimit,
  checkAgentTypeAllowed,
  checkMonthlyRunLimit,
  checkGatewayLimit,
  checkFeatureFlag,
} = require('../middleware/plan-limits');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal Express-like req/res/next triple.
 */
function makeContext({ plan = 'free', tenantId = 'ten_001', body = {} } = {}) {
  const req = {
    tenant_id: tenantId,
    body,
    params: {},
    originalUrl: '/api/v1/test',
    // tenantData will be cached here by the middleware
  };

  const res = {
    _status: null,
    _json: null,
    _headers: {},
    status(code) { this._status = code; return this; },
    json(data)   { this._json = data;   return this; },
    setHeader(k, v) { this._headers[k] = v; },
    req,
  };

  const next = jest.fn();

  // Pre-populate tenantData cache so loadTenantData skips DB query
  req.tenantData = { id: tenantId, plan, name: 'Test GmbH', settings: {} };

  return { req, res, next };
}

beforeEach(() => {
  mockQuery.mockReset();
});

// ── checkWorkflowLimit ────────────────────────────────────────────────────────

describe('checkWorkflowLimit', () => {
  it('calls next() when below limit (free plan: max 3, current 1)', async () => {
    const { req, res, next } = makeContext({ plan: 'free' });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] }); // current workflows

    await checkWorkflowLimit(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res._status).toBeNull();
  });

  it('returns 402 when at limit (free plan: max 3, current 3)', async () => {
    const { req, res, next } = makeContext({ plan: 'free' });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });

    await checkWorkflowLimit(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(402);
    expect(res._json.type).toContain('realsync');
    expect(res._json.limit).toBe(3);
    expect(res._json.current_count).toBe(3);
  });

  it('returns 402 when over limit (free plan: max 3, current 5)', async () => {
    const { req, res, next } = makeContext({ plan: 'free' });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '5' }] });

    await checkWorkflowLimit(req, res, next);

    expect(res._status).toBe(402);
  });

  it('calls next() on enterprise plan (unlimited: -1)', async () => {
    const { req, res, next } = makeContext({ plan: 'enterprise' });
    // No DB query expected — unlimited short-circuits

    await checkWorkflowLimit(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('includes next_plan in 402 response', async () => {
    const { req, res, next } = makeContext({ plan: 'free' });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });

    await checkWorkflowLimit(req, res, next);

    expect(res._json.next_plan).toBe('starter');
  });

  it('includes upgrade_url in 402 response', async () => {
    const { req, res, next } = makeContext({ plan: 'starter' });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '25' }] });

    await checkWorkflowLimit(req, res, next);

    expect(res._json.upgrade_url).toBeDefined();
    expect(typeof res._json.upgrade_url).toBe('string');
  });
});

// ── checkMonthlyRunLimit ──────────────────────────────────────────────────────

describe('checkMonthlyRunLimit', () => {
  it('calls next() when below monthly limit (free: 100, current 50)', async () => {
    const { req, res, next } = makeContext({ plan: 'free' });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '50' }] });

    await checkMonthlyRunLimit(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sets X-RateLimit headers on success', async () => {
    const { req, res, next } = makeContext({ plan: 'free' });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '50' }] });

    await checkMonthlyRunLimit(req, res, next);

    expect(res._headers['X-RateLimit-Runs-Remaining']).toBe(50);
    expect(res._headers['X-RateLimit-Runs-Limit']).toBe(100);
  });

  it('returns 402 when at monthly limit (free: 100, current 100)', async () => {
    const { req, res, next } = makeContext({ plan: 'free' });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '100' }] });

    await checkMonthlyRunLimit(req, res, next);

    expect(res._status).toBe(402);
    expect(res._json.monthly_limit).toBe(100);
    expect(res._json.current_runs_this_month).toBe(100);
  });

  it('includes limit_resets_at in 402 response', async () => {
    const { req, res, next } = makeContext({ plan: 'free' });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '100' }] });

    await checkMonthlyRunLimit(req, res, next);

    expect(res._json.limit_resets_at).toBeDefined();
    // Should be a valid ISO date string
    expect(new Date(res._json.limit_resets_at).getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('includes usage_percentage in 402 response', async () => {
    const { req, res, next } = makeContext({ plan: 'free' });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '100' }] });

    await checkMonthlyRunLimit(req, res, next);

    expect(res._json.usage_percentage).toBe(100);
  });

  it('skips DB query for enterprise (unlimited)', async () => {
    const { req, res, next } = makeContext({ plan: 'enterprise' });

    await checkMonthlyRunLimit(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ── checkAgentTypeAllowed ─────────────────────────────────────────────────────

describe('checkAgentTypeAllowed', () => {
  it('calls next() for allowed agent type (free → devops)', async () => {
    const { req, res, next } = makeContext({ plan: 'free', body: { agent_type: 'devops' } });

    await checkAgentTypeAllowed()(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 402 for disallowed type (free → marketing)', async () => {
    const { req, res, next } = makeContext({ plan: 'free', body: { agent_type: 'marketing' } });

    await checkAgentTypeAllowed()(req, res, next);

    expect(res._status).toBe(402);
    expect(res._json.requested_agent_type).toBe('marketing');
    expect(res._json.allowed_agent_types).toContain('devops');
  });

  it('uses static type override correctly', async () => {
    const { req, res, next } = makeContext({ plan: 'free' });

    await checkAgentTypeAllowed('research')(req, res, next);

    expect(res._status).toBe(402);
  });

  it('allows all types on professional plan', async () => {
    const types = ['devops', 'marketing', 'compliance', 'research'];

    for (const agentType of types) {
      const { req, res, next } = makeContext({ plan: 'professional', body: { agent_type: agentType } });
      await checkAgentTypeAllowed()(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res._status).toBeNull();
    }
  });

  it('calls next() when no agent_type provided (no check needed)', async () => {
    const { req, res, next } = makeContext({ plan: 'free', body: {} });

    await checkAgentTypeAllowed()(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

// ── checkGatewayLimit ─────────────────────────────────────────────────────────

describe('checkGatewayLimit', () => {
  it('calls next() when below gateway limit (free: 1, current 0)', async () => {
    const { req, res, next } = makeContext({ plan: 'free' });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });

    await checkGatewayLimit(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 402 when at gateway limit (free: 1, current 1)', async () => {
    const { req, res, next } = makeContext({ plan: 'free' });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });

    await checkGatewayLimit(req, res, next);

    expect(res._status).toBe(402);
    expect(res._json.limit).toBe(1);
  });

  it('skips DB for unlimited plan', async () => {
    const { req, res, next } = makeContext({ plan: 'enterprise' });

    await checkGatewayLimit(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ── checkFeatureFlag ──────────────────────────────────────────────────────────

describe('checkFeatureFlag', () => {
  it('returns 402 when compliance_reports disabled (free plan)', async () => {
    const { req, res, next } = makeContext({ plan: 'free' });

    await checkFeatureFlag('compliance_reports')(req, res, next);

    expect(res._status).toBe(402);
    expect(res._json.feature).toBe('compliance_reports');
  });

  it('calls next() when compliance_reports enabled (starter plan)', async () => {
    const { req, res, next } = makeContext({ plan: 'starter' });

    await checkFeatureFlag('compliance_reports')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('returns 402 when human_approval disabled (starter plan)', async () => {
    const { req, res, next } = makeContext({ plan: 'starter' });

    await checkFeatureFlag('human_approval')(req, res, next);

    expect(res._status).toBe(402);
  });

  it('calls next() when human_approval enabled (professional plan)', async () => {
    const { req, res, next } = makeContext({ plan: 'professional' });

    await checkFeatureFlag('human_approval')(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('includes next_plan in 402 response', async () => {
    const { req, res, next } = makeContext({ plan: 'free' });

    await checkFeatureFlag('compliance_reports')(req, res, next);

    expect(res._json.next_plan).toBe('starter');
  });
});
