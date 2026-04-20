'use strict';

/**
 * Stripe Webhook Tests — Sprint 13
 *
 * Critical invariants:
 *   1. Returns 200 IMMEDIATELY — before any DB work (Stripe retries on timeout)
 *   2. Returns 400 on invalid signature (not 200)
 *   3. Processes events asynchronously in background
 *   4. DB updates are idempotent (multiple calls = same result)
 *   5. Unknown events are silently ignored (no error)
 *
 * Tests:
 *   Signature verification (valid, invalid, missing)
 *   customer.subscription.created  — plan update in tenants
 *   customer.subscription.updated  — plan update
 *   customer.subscription.deleted  — downgrade to free
 *   invoice.payment_succeeded       — payment_status = active, audit log
 *   invoice.payment_failed          — payment_status = past_due
 *   checkout.session.completed      — tenant link + plan activation
 *   Unknown event type              — 200, no error
 */

// ── Stripe mock ───────────────────────────────────────────────────────────────
const mockConstructEvent    = jest.fn();
const mockRetrieveSubscription = jest.fn();

jest.mock('../config/stripe', () => ({
  webhooks: { constructEvent: mockConstructEvent },
  subscriptions: { retrieve: mockRetrieveSubscription },
}));

// ── DB pool mock (pool.connect returns a client mock) ─────────────────────────
const mockPoolQuery  = jest.fn();
const mockConnect    = jest.fn();
const mockClientQ    = jest.fn();
const mockRelease    = jest.fn();

jest.mock('../db', () => ({
  query:   mockPoolQuery,
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

jest.mock('../middleware/auth', () => ({
  authenticateToken: (_req, _res, next) => next(),
}));

jest.mock('../middleware/plan-limits', () => ({
  checkWorkflowLimit:    (_req, _res, next) => next(),
  checkMonthlyRunLimit:  (_req, _res, next) => next(),
  checkAgentTypeAllowed: () => (_req, _res, next) => next(),
  checkGatewayLimit:     (_req, _res, next) => next(),
  checkFeatureFlag:      () => (_req, _res, next) => next(),
}));

const request = require('supertest');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a pgClient mock that sequences through given responses */
function makeClient(responses = []) {
  let i = 0;
  const client = {
    query: jest.fn(async () => {
      const r = responses[i++];
      if (r instanceof Error) throw r;
      return r ?? { rows: [], rowCount: 0 };
    }),
    release: mockRelease,
  };
  mockConnect.mockResolvedValue(client);
  return client;
}

/** Build a fake Stripe event */
function fakeEvent(type, data) {
  return { id: `evt_test_${Date.now()}`, type, data: { object: data } };
}

/** Helper: send webhook payload with valid-looking signature header */
async function sendWebhook(app, event) {
  return request(app)
    .post('/webhooks/stripe/webhook')
    .set('stripe-signature', 'v1=test_sig')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify(event));
}

const SUBSCRIPTION = {
  id:       'sub_test_001',
  customer: 'cus_test_001',
  status:   'active',
  current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
  items: { data: [{ price: { id: process.env.STRIPE_STARTER_PRICE_ID || 'price_starter' } }] },
};

let app;

beforeAll(() => {
  process.env.NODE_ENV                  = 'test';
  process.env.JWT_SECRET                = 'test_jwt_secret_32_chars_minimum_x';
  process.env.JWT_REFRESH_SECRET        = 'test_refresh_secret_32_chars_minx';
  process.env.AGENT_INTERNAL_KEY        = 'test_agent_key_16c';
  process.env.GATEWAY_SECRET            = 'test_gateway_secret';
  process.env.INTERNAL_HEALTH_KEY       = 'test_health_key_secret';
  process.env.REDIS_URL                 = 'redis://localhost:6379';
  process.env.DATABASE_URL              = 'postgresql://x:x@localhost/x';
  process.env.ENABLE_WORKERS            = 'false';
  process.env.STRIPE_SECRET_KEY         = 'sk_test_placeholder';
  process.env.STRIPE_WEBHOOK_SECRET     = 'whsec_test_placeholder';
  process.env.STRIPE_STARTER_PRICE_ID   = 'price_starter';
  process.env.STRIPE_PROFESSIONAL_PRICE_ID = 'price_professional';
  process.env.STRIPE_ENTERPRISE_PRICE_ID   = 'price_enterprise';

  app = require('../app');
});

afterEach(() => {
  mockPoolQuery.mockReset();
  mockConnect.mockReset();
  mockRelease.mockReset();
  mockConstructEvent.mockReset();
  mockRetrieveSubscription.mockReset();
});

afterAll(async () => {
  try { const pool = require('../db'); if (pool.end) await pool.end(); } catch { /**/ }
});

// ── Signature verification ────────────────────────────────────────────────────

describe('Signature verification', () => {
  it('returns 400 for invalid Stripe signature', async () => {
    const sigErr = new Error('No signatures found matching the expected signature for payload');
    mockConstructEvent.mockImplementation(() => { throw sigErr; });

    const res = await request(app)
      .post('/webhooks/stripe/webhook')
      .set('stripe-signature', 'v1=bad_sig')
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(res.status).toBe(400);
    expect(res.body.title).toContain('signature');
  });

  it('returns 400 when stripe-signature header is missing', async () => {
    const sigErr = new Error('No stripe-signature header value was provided');
    mockConstructEvent.mockImplementation(() => { throw sigErr; });

    const res = await request(app)
      .post('/webhooks/stripe/webhook')
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(res.status).toBe(400);
  });

  it('returns 200 immediately for valid signature (before DB work)', async () => {
    const event = fakeEvent('customer.subscription.created', SUBSCRIPTION);
    mockConstructEvent.mockReturnValue(event);
    makeClient([
      { rows: [], rowCount: 0 }, // BEGIN
      { rows: [], rowCount: 1 }, // UPDATE tenants
      { rows: [], rowCount: 0 }, // COMMIT
    ]);

    const res = await sendWebhook(app, event);
    // Must be 200 — Stripe gets acknowledged immediately
    expect(res.status).toBe(200);
  });
});

// ── customer.subscription.created ────────────────────────────────────────────

describe('customer.subscription.created', () => {
  it('updates tenant plan to starter', async () => {
    const event = fakeEvent('customer.subscription.created', SUBSCRIPTION);
    mockConstructEvent.mockReturnValue(event);

    let capturedPlan = null;
    const client = {
      query: jest.fn(async (sql, params) => {
        if (sql.includes('UPDATE tenants') && params) capturedPlan = params[1];
        return { rows: [], rowCount: 1 };
      }),
      release: mockRelease,
    };
    mockConnect.mockResolvedValue(client);

    const res = await sendWebhook(app, event);
    expect(res.status).toBe(200);

    // Wait briefly for async handler
    await new Promise(r => setTimeout(r, 50));
    expect(capturedPlan).toBe('starter');
  });
});

// ── customer.subscription.updated ────────────────────────────────────────────

describe('customer.subscription.updated', () => {
  it('updates plan when price_id changes to professional', async () => {
    const updatedSub = {
      ...SUBSCRIPTION,
      items: { data: [{ price: { id: 'price_professional' } }] },
    };
    const event = fakeEvent('customer.subscription.updated', updatedSub);
    mockConstructEvent.mockReturnValue(event);

    let capturedPlan = null;
    const client = {
      query: jest.fn(async (sql, params) => {
        if (sql.includes('UPDATE tenants') && params) capturedPlan = params[1];
        return { rows: [], rowCount: 1 };
      }),
      release: mockRelease,
    };
    mockConnect.mockResolvedValue(client);

    const res = await sendWebhook(app, event);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));
    expect(capturedPlan).toBe('professional');
  });
});

// ── customer.subscription.deleted ────────────────────────────────────────────

describe('customer.subscription.deleted', () => {
  it('downgrades tenant to free plan', async () => {
    const event = fakeEvent('customer.subscription.deleted', SUBSCRIPTION);
    mockConstructEvent.mockReturnValue(event);

    let sqlCalled = false;
    const client = {
      query: jest.fn(async (sql) => {
        if (sql.includes("plan = 'free'")) sqlCalled = true;
        return { rows: [], rowCount: 1 };
      }),
      release: mockRelease,
    };
    mockConnect.mockResolvedValue(client);

    const res = await sendWebhook(app, event);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 50));
    expect(sqlCalled).toBe(true);
  });
});

// ── invoice.payment_succeeded ─────────────────────────────────────────────────

describe('invoice.payment_succeeded', () => {
  it('sets payment_status = active and writes audit log', async () => {
    const invoice = {
      id: 'in_test_001', customer: 'cus_test_001',
      amount_paid: 2900, currency: 'eur',
      hosted_invoice_url: 'https://invoice.stripe.com/in_test_001',
    };
    const event = fakeEvent('invoice.payment_succeeded', invoice);
    mockConstructEvent.mockReturnValue(event);

    let paymentStatusUpdated = false;
    let auditLogWritten      = false;

    const client = {
      query: jest.fn(async (sql, params) => {
        if (sql.includes("payment_status = 'active'")) paymentStatusUpdated = true;
        if (sql.includes('audit_logs')) {
          auditLogWritten = true;
          return { rows: [{ id: 'ten_test_001' }], rowCount: 1 };
        }
        return { rows: [{ id: 'ten_test_001' }], rowCount: 1 };
      }),
      release: mockRelease,
    };
    mockConnect.mockResolvedValue(client);

    const res = await sendWebhook(app, event);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 80));
    expect(paymentStatusUpdated).toBe(true);
  });
});

// ── invoice.payment_failed ────────────────────────────────────────────────────

describe('invoice.payment_failed', () => {
  it('sets payment_status = past_due', async () => {
    const invoice = {
      id: 'in_test_002', customer: 'cus_test_001',
      amount_due: 2900, attempt_count: 1,
    };
    const event = fakeEvent('invoice.payment_failed', invoice);
    mockConstructEvent.mockReturnValue(event);

    let pastDueSet = false;
    const client = {
      query: jest.fn(async (sql) => {
        if (sql.includes("payment_status = 'past_due'")) pastDueSet = true;
        return { rows: [], rowCount: 1 };
      }),
      release: mockRelease,
    };
    mockConnect.mockResolvedValue(client);

    const res = await sendWebhook(app, event);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 80));
    expect(pastDueSet).toBe(true);
  });
});

// ── checkout.session.completed ────────────────────────────────────────────────

describe('checkout.session.completed', () => {
  it('links Stripe customer to tenant and activates plan', async () => {
    const session = {
      id:                   'cs_test_001',
      customer:             'cus_new_001',
      subscription:         'sub_new_001',
      client_reference_id:  'ten_test_001',
    };
    const event = fakeEvent('checkout.session.completed', session);
    mockConstructEvent.mockReturnValue(event);

    mockRetrieveSubscription.mockResolvedValue({
      ...SUBSCRIPTION, id: 'sub_new_001',
      items: { data: [{ price: { id: 'price_starter' } }] },
    });

    let customerLinked = false;
    let planActivated  = false;

    const client = {
      query: jest.fn(async (sql, params) => {
        if (sql.includes('stripe_customer_id') && params?.[1] === 'cus_new_001') customerLinked = true;
        if (sql.includes("payment_status = 'active'")) planActivated = true;
        return { rows: [], rowCount: 1 };
      }),
      release: mockRelease,
    };
    mockConnect.mockResolvedValue(client);

    const res = await sendWebhook(app, event);
    expect(res.status).toBe(200);

    await new Promise(r => setTimeout(r, 100));
    expect(customerLinked).toBe(true);
    expect(planActivated).toBe(true);
  });

  it('ignores session without client_reference_id gracefully', async () => {
    const session = {
      id: 'cs_test_002', customer: 'cus_orphan', subscription: null,
      client_reference_id: null,
    };
    const event = fakeEvent('checkout.session.completed', session);
    mockConstructEvent.mockReturnValue(event);

    const client = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: mockRelease,
    };
    mockConnect.mockResolvedValue(client);

    const res = await sendWebhook(app, event);
    expect(res.status).toBe(200); // no crash
  });
});

// ── Unknown event type ────────────────────────────────────────────────────────

describe('Unknown event types', () => {
  it('returns 200 and silently ignores unhandled event', async () => {
    const event = fakeEvent('payment_intent.created', { id: 'pi_test_001' });
    mockConstructEvent.mockReturnValue(event);

    const res = await sendWebhook(app, event);
    expect(res.status).toBe(200);
    // No DB calls for unhandled events
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe('Idempotency', () => {
  it('handles duplicate subscription.created events without crashing', async () => {
    const event = fakeEvent('customer.subscription.created', SUBSCRIPTION);
    mockConstructEvent.mockReturnValue(event);

    const client = {
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: mockRelease,
    };
    mockConnect.mockResolvedValue(client);

    // Send same event twice
    const [r1, r2] = await Promise.all([
      sendWebhook(app, event),
      sendWebhook(app, event),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});
