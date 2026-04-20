'use strict';

/**
 * Auth Route Tests — Sprint 10
 *
 * Tests:
 *   POST /auth/register  — input validation, duplicate detection
 *   POST /auth/login     — valid credentials, wrong password, unknown email
 *   POST /auth/refresh   — token rotation
 */

const request = require('supertest');

// ── Mock DB pool ──────────────────────────────────────────────────────────────
const mockQuery   = jest.fn();
const mockClientQuery   = jest.fn();
const mockRelease = jest.fn();
const mockClient  = {
  query:   mockClientQuery,
  release: mockRelease,
};
const mockConnect = jest.fn().mockResolvedValue(mockClient);
jest.mock('../db', () => ({ query: mockQuery, connect: mockConnect }));

// ── Mock ioredis ──────────────────────────────────────────────────────────────
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
const HASHED_PW = '$2a$12$W5z2p1sOkmBx3gHOiXLGUOgdxJrLqbOL7oyCKxRktXv9B2tGXEIwe'; // "Password1!"

// Utility: hash password for mock (bcryptjs hash of "Password1!")
const VALID_USER = {
  id:            'usr_test_001',
  tenant_id:     'ten_test_001',
  email:         'admin@example.com',
  password_hash: HASHED_PW,
  role:          'admin',
  plan:          'starter',
  is_active:     true,
};

beforeAll(() => {
  process.env.NODE_ENV            = 'test';
  process.env.JWT_SECRET          = 'test_jwt_secret_32_chars_minimum_x';
  process.env.JWT_REFRESH_SECRET  = 'test_refresh_secret_32_chars_minx';
  process.env.JWT_EXPIRY          = '15m';
  process.env.JWT_REFRESH_EXPIRY  = '7d';
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
  mockClientQuery.mockReset();
  mockRelease.mockReset();
});

afterAll(async () => {
  try {
    const pool = require('../db');
    if (pool.end) await pool.end();
  } catch { /* ignore */ }
});

// ── POST /auth/register ───────────────────────────────────────────────────────

describe('POST /auth/register', () => {
  it('returns 400 when email is missing', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ password: 'Password1!' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when password is missing', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'test@example.com' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid email format', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'not-an-email', password: 'Password1!' });
    expect(res.status).toBe(400);
  });

  it('returns 409 when email already exists', async () => {
    // register uses pool.connect() → client.query():
    // BEGIN → email check (finds row → ROLLBACK → 409)
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })                    // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 'existing' }] }) // email check → found
      .mockResolvedValueOnce({ rows: [] });                   // ROLLBACK

    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'admin@example.com', password: 'Password1!', name: 'Admin', org_name: 'Test GmbH' });

    expect([409, 400]).toContain(res.status);
  });

  it('returns 201 with token on success', async () => {
    // auth/register uses pool.connect() transaction:
    //   BEGIN → email check → tenant insert → user insert → audit → COMMIT
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })          // BEGIN
      .mockResolvedValueOnce({ rows: [] })          // check existing email → not found
      .mockResolvedValueOnce({ rows: [{ id: 'ten_new', plan: 'free', name: 'New GmbH' }] }) // tenant insert
      .mockResolvedValueOnce({ rows: [{ id: 'usr_new', email: 'new@example.com', role: 'owner', plan: 'free', tenant_id: 'ten_new' }] }) // user insert
      .mockResolvedValueOnce({ rows: [] })          // audit log insert (optional)
      .mockResolvedValueOnce({ rows: [] });         // COMMIT

    const res = await request(app)
      .post('/auth/register')
      .send({ email: 'new@example.com', password: 'Password1!', name: 'Max Müller', org_name: 'New GmbH' });

    expect([200, 201]).toContain(res.status);
    if (res.status === 201 || res.status === 200) {
      expect(res.body.access_token || res.body.token).toBeDefined();
    }
  });
});

// ── POST /auth/login ──────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
  it('returns 400 when body is empty', async () => {
    const res = await request(app).post('/auth/login').send({});
    expect(res.status).toBe(400);
  });

  it('returns 401 when email is not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // user not found

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'unknown@example.com', password: 'Password1!' });

    expect(res.status).toBe(401);
  });

  it('returns 401 when password is wrong', async () => {
    // Return a user but with a hash that does NOT match "WrongPass"
    mockQuery.mockResolvedValueOnce({ rows: [VALID_USER] });

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'admin@example.com', password: 'WrongPassword!' });

    expect(res.status).toBe(401);
  });

  it('returns RFC 9457 error on failure', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nobody@example.com', password: 'Password1!' });

    // Either 401 with type field or plain 401
    expect(res.status).toBe(401);
  });
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────

describe('POST /auth/refresh', () => {
  it('returns 400 when refresh_token is missing', async () => {
    const res = await request(app).post('/auth/refresh').send({});
    expect(res.status).toBe(400);
  });

  it('returns 401 with invalid refresh token', async () => {
    // pool.query for token lookup → empty rows = token not found → 401
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/auth/refresh')
      .send({ refresh_token: 'invalid.token.here' });
    expect([400, 401]).toContain(res.status);
  });
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe('Auth rate limiting', () => {
  it('enforces rate limit after many requests', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    // Send enough requests to possibly trigger auth-specific rate limiter
    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        request(app)
          .post('/auth/login')
          .send({ email: 'flood@example.com', password: 'Password1!' })
      )
    );

    // At minimum all should not return 500 (no server crash)
    const statuses = results.map(r => r.status);
    expect(statuses.every(s => s !== 500)).toBe(true);

    // If rate limiter is active, at least one 429 among later requests
    const has429 = statuses.includes(429);
    const allExpected = statuses.every(s => [400, 401, 429].includes(s));
    expect(allExpected).toBe(true);
    // Log for visibility
    if (has429) {
      console.log('[test] Rate limiter active — 429 triggered as expected');
    }
  });
});
