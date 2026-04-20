'use strict';

/**
 * Billing Route Tests — Sprint 12
 *
 * All Stripe calls are mocked — no network required.
 *
 * Tests:
 *   GET  /billing/subscription  — no customer, existing customer
 *   POST /billing/checkout      — invalid plan, enterprise (no price_id), success
 *   POST /billing/portal        — no customer, success
 *   POST /billing/cancel        — no customer, no active sub, success
 *   GET  /billing/invoices      — no customer (empty), with invoices
 *   GET  /billing/usage         — aggregated DB metrics
 */

// ── Stripe mock ───────────────────────────────────────────────────────────────
const mockStripe = {
  customers: {
    create: jest.fn(),
  },
  subscriptions: {
    list:   jest.fn(),
    update: jest.fn(),
  },
  checkout: {
    sessions: { create: jest.fn() },
  },
  billingPortal: {
    sessions: { create: jest.fn() },
  },
  invoices: {
    list: jest.fn(),
  },
};

jest.mock('stripe', () => jest.fn(() => mockStripe));

// Bypass the lazy Proxy in config/stripe.js — billing.js imports from there
jest.mock('../config/stripe', () => mockStripe);

// Mock plans so stripe_price_id is always set (env vars are undefined at module load time in tests)
jest.mock('../config/plans', () => ({
  PLANS: {
    free:         { name: 'Free',         price_monthly: 0,    stripe_price_id: null,                      limits: { max_workflows: 3,   max_gateways: 1,  max_agent_runs_per_month: 100   } },
    starter:      { name: 'Starter',      price_monthly: 29,   stripe_price_id: 'price_starter_test',      limits: { max_workflows: 25,  max_gateways: 5,  max_agent_runs_per_month: 2500  } },
    professional: { name: 'Professional', price_monthly: 99,   stripe_price_id: 'price_professional_test', limits: { max_workflows: 100, max_gateways: 20, max_agent_runs_per_month: 15000 } },
    enterprise:   { name: 'Enterprise',   price_monthly: null, stripe_price_id: null,                      limits: { max_workflows: -1,  max_gateways: -1, max_agent_runs_per_month: -1    } },
  },
  getUpgradeUrl: () => 'https://app.realsyncdynamics.com/billing/upgrade',
  getPlanByStripePriceId: (id) => {
    const map = { 'price_starter_test': 'starter', 'price_professional_test': 'professional' };
    return map[id] || null;
  },
  isLimitExceeded: (limit, current) => limit !== -1 && current >= limit,
}));

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

// ── Auth mock — inject tenant_id into req ─────────────────────────────────────
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user      = { id: 'user-001', email: 'test@realsync.io', role: 'admin', tenant_id: 'ten_test_001' };
    req.tenant_id = 'ten_test_001';
    req.user_id   = 'usr_test_001';
    req.user_role = 'admin';
    next();
  },
  authenticateToken: (req, _res, next) => {
    req.tenant_id = 'ten_test_001';
    req.user_id   = 'usr_test_001';
    req.user_role = 'admin';
    next();
  },
}));

const request = require('supertest');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT_FREE = {
  id:                 'ten_test_001',
  name:               'Test GmbH',
  plan:               'free',
  stripe_customer_id: null,
  settings:           {},
};

const TENANT_WITH_STRIPE = {
  ...TENANT_FREE,
  plan:               'starter',
  stripe_customer_id: 'cus_test_001',
};

const STRIPE_SUBSCRIPTION = {
  id:                    'sub_test_001',
  status:                'active',
  current_period_start:  Math.floor(Date.now() / 1000) - 86400,
  current_period_end:    Math.floor(Date.now() / 1000) + 86400 * 29,
  cancel_at_period_end:  false,
  cancel_at:             null,
  current_period_end:    Math.floor(Date.now() / 1000) + 86400 * 29,
  default_payment_method: {
    card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2027 },
  },
  metadata: { plan: 'starter', tenant_id: 'ten_test_001' },
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
  process.env.STRIPE_SECRET_KEY            = 'sk_test_placeholder';
  process.env.STRIPE_STARTER_PRICE_ID      = 'price_starter_test';
  process.env.STRIPE_PROFESSIONAL_PRICE_ID = 'price_professional_test';
  process.env.STRIPE_ENTERPRISE_PRICE_ID   = 'price_enterprise_test';

  app = require('../app');
});

afterEach(() => {
  mockQuery.mockReset();
  jest.clearAllMocks();
});

afterAll(async () => {
  try {
    const pool = require('../db');
    if (pool.end) await pool.end();
  } catch { /* ignore */ }
});

// ── GET /billing/subscription ─────────────────────────────────────────────────

describe('GET /billing/subscription', () => {
  it('returns plan info without Stripe when no customer_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [TENANT_FREE] });

    const res = await request(app).get('/api/v1/billing/subscription');
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('free');
    expect(res.body.subscription).toBeNull();
    expect(res.body.limits).toBeDefined();
  });

  it('returns active subscription details with customer_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [TENANT_WITH_STRIPE] });
    mockStripe.subscriptions.list.mockResolvedValueOnce({
      data: [STRIPE_SUBSCRIPTION],
    });

    const res = await request(app).get('/api/v1/billing/subscription');
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('starter');
    expect(res.body.subscription.id).toBe('sub_test_001');
    expect(res.body.subscription.status).toBe('active');
    expect(res.body.subscription.payment_method.last4).toBe('4242');
  });

  it('returns 404 when tenant not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/api/v1/billing/subscription');
    expect(res.status).toBe(404);
    expect(res.body.type).toContain('realsync');
  });

  it('handles Stripe error gracefully with 502', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [TENANT_WITH_STRIPE] });
    const stripeErr = new Error('Stripe unavailable');
    stripeErr.type = 'StripeConnectionError';
    mockStripe.subscriptions.list.mockRejectedValueOnce(stripeErr);

    const res = await request(app).get('/api/v1/billing/subscription');
    expect(res.status).toBe(502);
    expect(res.body.title).toContain('Stripe');
  });
});

// ── POST /billing/checkout ────────────────────────────────────────────────────

describe('POST /billing/checkout', () => {
  it('returns 400 for missing plan', async () => {
    const res = await request(app).post('/api/v1/billing/checkout').send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid plan name', async () => {
    const res = await request(app)
      .post('/api/v1/billing/checkout')
      .send({ plan: 'ultra' });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('ultra');
  });

  it('returns 400 for enterprise (no stripe_price_id)', async () => {
    // enterprise plan has no stripe_price_id (custom pricing)
    const res = await request(app)
      .post('/api/v1/billing/checkout')
      .send({ plan: 'enterprise' });
    expect([400, 404]).toContain(res.status);
  });

  it('creates checkout session for starter plan', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [TENANT_FREE] })      // getTenant
      .mockResolvedValueOnce({ rows: [{ id: 'cus_new' }] }); // update stripe_customer_id

    mockStripe.customers.create.mockResolvedValueOnce({ id: 'cus_new' });
    mockStripe.checkout.sessions.create.mockResolvedValueOnce({
      id:  'cs_test_001',
      url: 'https://checkout.stripe.com/pay/cs_test_001',
    });

    const res = await request(app)
      .post('/api/v1/billing/checkout')
      .send({ plan: 'starter' });

    expect(res.status).toBe(201);
    expect(res.body.checkout_url).toContain('stripe.com');
    expect(res.body.session_id).toBe('cs_test_001');
  });

  it('reuses existing Stripe customer ID (no create call)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [TENANT_WITH_STRIPE] }); // getTenant
    mockStripe.checkout.sessions.create.mockResolvedValueOnce({
      id:  'cs_test_002',
      url: 'https://checkout.stripe.com/pay/cs_test_002',
    });

    const res = await request(app)
      .post('/api/v1/billing/checkout')
      .send({ plan: 'professional' });

    expect(res.status).toBe(201);
    expect(mockStripe.customers.create).not.toHaveBeenCalled();
  });
});

// ── POST /billing/portal ──────────────────────────────────────────────────────

describe('POST /billing/portal', () => {
  it('returns 400 when no Stripe customer exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [TENANT_FREE] });

    const res = await request(app).post('/api/v1/billing/portal');
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain('Stripe');
  });

  it('returns portal URL for existing customer', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [TENANT_WITH_STRIPE] });
    mockStripe.billingPortal.sessions.create.mockResolvedValueOnce({
      url: 'https://billing.stripe.com/session/bps_test_001',
    });

    const res = await request(app).post('/api/v1/billing/portal');
    expect(res.status).toBe(200);
    expect(res.body.portal_url).toContain('stripe.com');
  });
});

// ── POST /billing/cancel ──────────────────────────────────────────────────────

describe('POST /billing/cancel', () => {
  it('returns 400 when no stripe customer', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [TENANT_FREE] });

    const res = await request(app).post('/api/v1/billing/cancel');
    expect(res.status).toBe(400);
  });

  it('returns 404 when no active subscription', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [TENANT_WITH_STRIPE] });
    mockStripe.subscriptions.list.mockResolvedValueOnce({ data: [] });

    const res = await request(app).post('/api/v1/billing/cancel');
    expect(res.status).toBe(404);
    expect(res.body.title).toContain('Subscription');
  });

  it('cancels subscription at period end', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [TENANT_WITH_STRIPE] })          // getTenant
      .mockResolvedValueOnce({ rows: [{ id: 'al_001' }] });           // audit_log insert

    mockStripe.subscriptions.list.mockResolvedValueOnce({
      data: [STRIPE_SUBSCRIPTION],
    });
    mockStripe.subscriptions.update.mockResolvedValueOnce({
      ...STRIPE_SUBSCRIPTION,
      cancel_at_period_end: true,
      cancel_at: STRIPE_SUBSCRIPTION.current_period_end,
    });

    const res = await request(app).post('/api/v1/billing/cancel');
    expect(res.status).toBe(200);
    expect(res.body.subscription_id).toBe('sub_test_001');
    expect(res.body.cancel_at).toBeDefined();
    expect(res.body.access_until).toBeDefined();
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith(
      'sub_test_001',
      { cancel_at_period_end: true }
    );
  });
});

// ── GET /billing/invoices ─────────────────────────────────────────────────────

describe('GET /billing/invoices', () => {
  it('returns empty array when no Stripe customer', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [TENANT_FREE] });

    const res = await request(app).get('/api/v1/billing/invoices');
    expect(res.status).toBe(200);
    expect(res.body.invoices).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('returns formatted invoice list', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [TENANT_WITH_STRIPE] });
    mockStripe.invoices.list.mockResolvedValueOnce({
      data: [
        {
          id:                  'in_test_001',
          number:              'RS-0001',
          status:              'paid',
          amount_paid:         2900,
          currency:            'eur',
          period_start:        Math.floor(Date.now() / 1000) - 86400 * 30,
          period_end:          Math.floor(Date.now() / 1000),
          created:             Math.floor(Date.now() / 1000) - 86400 * 30,
          invoice_pdf:         'https://invoice.stripe.com/pdf/in_test_001',
          hosted_invoice_url:  'https://invoice.stripe.com/in_test_001',
          subscription:        { metadata: { plan: 'starter' } },
        },
      ],
      has_more: false,
    });

    const res = await request(app).get('/api/v1/billing/invoices');
    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0].amount_paid).toBe(29);      // 2900 cents → €29
    expect(res.body.invoices[0].currency).toBe('EUR');
    expect(res.body.invoices[0].plan).toBe('starter');
    expect(res.body.invoices[0].pdf_url).toContain('stripe.com');
    expect(res.body.has_more).toBe(false);
  });
});

// ── GET /billing/usage ────────────────────────────────────────────────────────

describe('GET /billing/usage', () => {
  it('returns usage metrics with percentages', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [TENANT_FREE] })          // getTenant
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })       // workflows
      .mockResolvedValueOnce({ rows: [{ count: '45' }] })      // agent_runs
      .mockResolvedValueOnce({ rows: [{ count: '120' }] })     // api_calls (access_logs)
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });      // gateways

    const res = await request(app).get('/api/v1/billing/usage');
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('free');
    expect(res.body.usage.workflows.current).toBe(2);
    expect(res.body.usage.workflows.limit).toBe(3);           // free plan limit
    expect(res.body.usage.workflows.percentage).toBe(67);
    expect(res.body.usage.agent_runs.current).toBe(45);
    expect(res.body.usage.agent_runs.percentage).toBe(45);    // 45/100 * 100
    expect(res.body.usage.gateways.current).toBe(1);
    expect(res.body.period.start).toBeDefined();
    expect(res.body.upgrade_url).toBeDefined();
  });

  it('returns null percentage for unlimited enterprise plan', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...TENANT_WITH_STRIPE, plan: 'enterprise' }] })
      .mockResolvedValueOnce({ rows: [{ count: '50' }] })   // workflows
      .mockResolvedValueOnce({ rows: [{ count: '999' }] })  // agent_runs
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })    // api_calls
      .mockResolvedValueOnce({ rows: [{ count: '5' }] });   // gateways

    const res = await request(app).get('/api/v1/billing/usage');
    expect(res.status).toBe(200);
    expect(res.body.usage.workflows.unlimited).toBe(true);
    expect(res.body.usage.workflows.percentage).toBeNull();
    expect(res.body.usage.agent_runs.unlimited).toBe(true);
  });
});
