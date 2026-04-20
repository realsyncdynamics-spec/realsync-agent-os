'use strict';

/**
 * gateways.test.js — Sprint 14
 * Tests für routes/gateways.js (OpenClaw Gateway Management)
 *
 * Endpoints:
 *   POST   /gateways/register
 *   POST   /gateways/:id/heartbeat
 *   GET    /gateways/
 *   GET    /gateways/:id
 *   DELETE /gateways/:id
 */

const request = require('supertest');
const express = require('express');

// ─── Mock: DB pool ────────────────────────────────────────────────────────────
const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: mockQuery }));

// ─── Mock: auth middleware ────────────────────────────────────────────────────
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user      = { id: 'user-001', email: 'dev@realsync.io' };
    req.tenant_id = 'tenant-abc';
    next();
  },
}));

// ─── Mock: plan-limits middleware ─────────────────────────────────────────────
jest.mock('../middleware/plan-limits', () => ({
  planLimits: () => (_req, _res, next) => next(),
}));

// ─── App setup ────────────────────────────────────────────────────────────────
const gatewaysRouter = require('../routes/gateways');
const { authenticate } = require('../middleware/auth');

const app = express();
app.use(express.json());
app.use(authenticate);
app.use('/gateways', gatewaysRouter);

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const GATEWAY_ROW = {
  id:           'gw-001',
  tenant_id:    'tenant-abc',
  name:         'Primary Gateway',
  host:         'gateway.internal',
  port:         8443,
  status:       'offline',
  capabilities: { exec: true },
  tags:         ['prod'],
  created_at:   '2026-04-01T00:00:00.000Z',
  updated_at:   '2026-04-01T00:00:00.000Z',
};

const GATEWAY_DETAIL = {
  ...GATEWAY_ROW,
  tls_fingerprint: 'AA:BB:CC',
  version:         '1.2.0',
  last_heartbeat:  null,
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── POST /gateways/register ──────────────────────────────────────────────────
describe('POST /gateways/register', () => {
  it('registers a gateway and returns 201 without api_key_hash', async () => {
    // First call: UPSERT → returns gateway row
    // Second call: audit log INSERT → void
    mockQuery
      .mockResolvedValueOnce({ rows: [GATEWAY_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/gateways/register')
      .send({
        name:    'Primary Gateway',
        host:    'gateway.internal',
        port:    8443,
        api_key: 'super-secret-key-123',
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      id:   'gw-001',
      name: 'Primary Gateway',
      host: 'gateway.internal',
    });
    // api_key_hash must NOT be in response (security invariant)
    expect(res.body.data.api_key_hash).toBeUndefined();
  });

  it('accepts optional fields: tls_fingerprint, capabilities, tags', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [GATEWAY_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/gateways/register')
      .send({
        name:            'Edge Gateway',
        host:            'edge.internal',
        api_key:         'key-abc',
        tls_fingerprint: 'AA:BB:CC',
        capabilities:    { exec: true, monitor: true },
        tags:            ['edge', 'prod'],
      });

    expect(res.status).toBe(201);
    // UPSERT query should have been called with api_key_hash (SHA-256 result)
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('ON CONFLICT (tenant_id, host)');
    // The hash argument should be a 64-char hex string
    const apiKeyHashArg = insertCall[1][4]; // 5th param is api_key_hash
    expect(apiKeyHashArg).toMatch(/^[a-f0-9]{64}$/);
  });

  it('defaults port to 3000 when not supplied', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ...GATEWAY_ROW, port: 3000 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/gateways/register')
      .send({ name: 'Lite GW', host: 'lite.internal', api_key: 'k' });

    expect(res.status).toBe(201);
    const insertCall = mockQuery.mock.calls[0];
    const portArg = insertCall[1][3]; // 4th param is portNum
    expect(portArg).toBe(3000);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/gateways/register')
      .send({ host: 'gateway.internal', api_key: 'k' });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/name.*host.*api_key/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 when host is missing', async () => {
    const res = await request(app)
      .post('/gateways/register')
      .send({ name: 'GW', api_key: 'k' });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/name.*host.*api_key/i);
  });

  it('returns 400 when api_key is missing', async () => {
    const res = await request(app)
      .post('/gateways/register')
      .send({ name: 'GW', host: 'gw.internal' });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/name.*host.*api_key/i);
  });

  it('returns 400 for invalid port (-1)', async () => {
    // port: 0 is falsy in JS — the route defaults it to 3000 via || '3000'
    // port: -1 is a real negative value that triggers the < 1 guard
    const res = await request(app)
      .post('/gateways/register')
      .send({ name: 'GW', host: 'gw.internal', api_key: 'k', port: -1 });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/port/i);
  });

  it('returns 400 for invalid port (65536)', async () => {
    const res = await request(app)
      .post('/gateways/register')
      .send({ name: 'GW', host: 'gw.internal', api_key: 'k', port: 65536 });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/port/i);
  });

  it('returns 400 for non-numeric port string', async () => {
    const res = await request(app)
      .post('/gateways/register')
      .send({ name: 'GW', host: 'gw.internal', api_key: 'k', port: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/port/i);
  });

  it('returns 500 on DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app)
      .post('/gateways/register')
      .send({ name: 'GW', host: 'gw.internal', api_key: 'k' });

    expect(res.status).toBe(500);
    expect(res.body.title).toBe('Internal Server Error');
  });

  it('writes audit log after successful registration', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [GATEWAY_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post('/gateways/register')
      .send({ name: 'GW', host: 'gw.internal', api_key: 'k' });

    // Second DB call should be the audit log INSERT
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const auditCall = mockQuery.mock.calls[1];
    expect(auditCall[0]).toContain('INSERT INTO audit_logs');
    expect(auditCall[1]).toContain('gateway.register');
  });
});

// ─── POST /gateways/:id/heartbeat ────────────────────────────────────────────
describe('POST /gateways/:id/heartbeat', () => {
  it('updates status to online and returns 200', async () => {
    const heartbeatRow = {
      id:             'gw-001',
      status:         'online',
      last_heartbeat: '2026-04-20T18:00:00.000Z',
      version:        null,
    };
    mockQuery.mockResolvedValueOnce({ rows: [heartbeatRow] });

    const res = await request(app)
      .post('/gateways/gw-001/heartbeat')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('online');
    expect(res.body.data.last_heartbeat).toBeDefined();
  });

  it('accepts optional version and capabilities in heartbeat', async () => {
    const heartbeatRow = {
      id:             'gw-001',
      status:         'online',
      last_heartbeat: '2026-04-20T18:00:00.000Z',
      version:        '2.0.0',
    };
    mockQuery.mockResolvedValueOnce({ rows: [heartbeatRow] });

    const res = await request(app)
      .post('/gateways/gw-001/heartbeat')
      .send({ version: '2.0.0', capabilities: { exec: true } });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe('2.0.0');
  });

  it('returns 404 when gateway does not exist or belongs to different tenant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/gateways/gw-999/heartbeat')
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.detail).toContain('gw-999');
  });

  it('returns 500 on DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB timeout'));

    const res = await request(app)
      .post('/gateways/gw-001/heartbeat')
      .send({});

    expect(res.status).toBe(500);
  });
});

// ─── GET /gateways ────────────────────────────────────────────────────────────
describe('GET /gateways/', () => {
  it('returns a list of all tenant gateways', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [GATEWAY_ROW, { ...GATEWAY_ROW, id: 'gw-002' }] });

    const res = await request(app).get('/gateways/');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it('returns empty array when tenant has no gateways', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/gateways/');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('filters by ?status=online', async () => {
    const onlineRow = { ...GATEWAY_ROW, status: 'online' };
    mockQuery.mockResolvedValueOnce({ rows: [onlineRow] });

    const res = await request(app).get('/gateways/?status=online');

    expect(res.status).toBe(200);
    expect(res.body.data[0].status).toBe('online');

    // The query should have included the status filter
    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall[1]).toContain('online');
  });

  it('filters by ?status=offline', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [GATEWAY_ROW] });

    const res = await request(app).get('/gateways/?status=offline');

    expect(res.status).toBe(200);
    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall[1]).toContain('offline');
  });

  it('returns 500 on DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));

    const res = await request(app).get('/gateways/');

    expect(res.status).toBe(500);
  });
});

// ─── GET /gateways/:id ───────────────────────────────────────────────────────
describe('GET /gateways/:id', () => {
  it('returns gateway detail including tls_fingerprint', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [GATEWAY_DETAIL] });

    const res = await request(app).get('/gateways/gw-001');

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('gw-001');
    expect(res.body.data.tls_fingerprint).toBe('AA:BB:CC');
  });

  it('enforces tenant isolation — returns 404 for wrong tenant', async () => {
    // DB returns empty because id + tenant_id mismatch
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/gateways/gw-other-tenant');

    expect(res.status).toBe(404);
    expect(res.body.detail).toContain('gw-other-tenant');
  });

  it('returns 404 when gateway does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/gateways/nonexistent');

    expect(res.status).toBe(404);
  });

  it('passes both id and tenant_id to DB query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [GATEWAY_DETAIL] });

    await request(app).get('/gateways/gw-001');

    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall[1]).toEqual(['gw-001', 'tenant-abc']);
  });

  it('returns 500 on DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('query failed'));

    const res = await request(app).get('/gateways/gw-001');

    expect(res.status).toBe(500);
  });
});

// ─── DELETE /gateways/:id ────────────────────────────────────────────────────
describe('DELETE /gateways/:id', () => {
  it('deletes a gateway and returns 204 (hard delete)', async () => {
    // First call: SELECT to check existence
    // Second call: DELETE
    // Third call: audit log INSERT
    mockQuery
      .mockResolvedValueOnce({ rows: [GATEWAY_ROW] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete('/gateways/gw-001');

    expect(res.status).toBe(204);
    expect(res.body).toEqual({}); // 204 = no body
  });

  it('executes a hard DELETE (not UPDATE status)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [GATEWAY_ROW] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).delete('/gateways/gw-001');

    const deleteCall = mockQuery.mock.calls[1];
    expect(deleteCall[0].trim().toUpperCase()).toMatch(/^DELETE FROM/);
    expect(deleteCall[0]).not.toMatch(/UPDATE/i);
  });

  it('returns 404 when gateway does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete('/gateways/gw-999');

    expect(res.status).toBe(404);
    expect(res.body.detail).toContain('gw-999');
  });

  it('returns 404 on cross-tenant delete attempt (tenant isolation)', async () => {
    // SELECT with tenant_id filter returns nothing
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete('/gateways/gw-other');

    expect(res.status).toBe(404);
    // DELETE query must NOT have been called
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('writes audit log with gateway.deregister action', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [GATEWAY_ROW] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).delete('/gateways/gw-001');

    const auditCall = mockQuery.mock.calls[2];
    expect(auditCall[0]).toContain('INSERT INTO audit_logs');
    expect(auditCall[1]).toContain('gateway.deregister');
  });

  it('audit log before snapshot contains name and host', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [GATEWAY_ROW] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).delete('/gateways/gw-001');

    const auditCall = mockQuery.mock.calls[2];
    // before param is JSON string at index 5
    const beforeJson = auditCall[1][5];
    const before = JSON.parse(beforeJson);
    expect(before.name).toBe('Primary Gateway');
    expect(before.host).toBe('gateway.internal');
  });

  it('returns 500 on DB error during existence check', async () => {
    mockQuery.mockRejectedValueOnce(new Error('lock timeout'));

    const res = await request(app).delete('/gateways/gw-001');

    expect(res.status).toBe(500);
  });
});
