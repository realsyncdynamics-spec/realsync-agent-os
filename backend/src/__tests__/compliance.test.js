'use strict';

/**
 * compliance.test.js — Sprint 14
 * Tests für routes/compliance.js (EU-AI-Act Compliance-Reports)
 * Rechtsgrundlage: Verordnung (EU) 2024/1689, Art. 12, 17
 *
 * Endpoints:
 *   GET  /compliance/reports         — paginiert, filterbar
 *   POST /compliance/reports         — Report erstellen
 *   GET  /compliance/reports/:id     — Detail + audit_trail
 *
 * KRITISCH: risk_level = minimal|limited|high
 *   (NICHT low|medium|high|critical wie bei approvals!)
 */

const request = require('supertest');
const express = require('express');

// ─── Mock: DB pool ────────────────────────────────────────────────────────────
const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: mockQuery }));

// ─── Mock: auth middleware ────────────────────────────────────────────────────
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.user      = { id: 'user-001', email: 'compliance@realsync.io' };
    req.tenant_id = 'tenant-abc';
    next();
  },
}));

// ─── Mock: plan-limits middleware ─────────────────────────────────────────────
jest.mock('../middleware/plan-limits', () => ({
  planLimits: () => (_req, _res, next) => next(),
}));

// ─── App setup ────────────────────────────────────────────────────────────────
const complianceRouter = require('../routes/compliance');
const { authenticate } = require('../middleware/auth');

const app = express();
app.use(express.json());
app.use(authenticate);
app.use('/compliance', complianceRouter);

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const REPORT_ROW = {
  id:               'rpt-001',
  tenant_id:        'tenant-abc',
  workflow_id:      'wf-001',
  report_type:      'eu_ai_act',
  risk_level:       'limited',
  findings:         JSON.stringify({ issues: [] }),
  recommendations:  JSON.stringify([]),
  generated_by:     'compliance',
  approved_by:      null,
  expires_at:       null,
  generated_at:     '2026-04-20T10:00:00.000Z',
  workflow_title:   'Daily Health Check',
  approved_by_name: null,
};

const REPORT_DETAIL = {
  ...REPORT_ROW,
  workflow_goal:     'Monitor system health',
  approved_by_email: null,
};

const AUDIT_TRAIL = [
  {
    id:         'al-001',
    action:     'compliance.report.create',
    user_id:    'user-001',
    created_at: '2026-04-20T10:00:00.000Z',
    ip:         '127.0.0.1',
  },
];

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── GET /compliance/reports ──────────────────────────────────────────────────
describe('GET /compliance/reports', () => {
  it('returns paginated list with meta', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_ROW] })             // main query
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });         // count query

    const res = await request(app).get('/compliance/reports');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toMatchObject({
      total: 1,
      page:  1,
      limit: 20,
      pages: 1,
    });
  });

  it('returns empty list when no reports exist', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(app).get('/compliance/reports');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it('filters by ?risk_level=high', async () => {
    const highRow = { ...REPORT_ROW, risk_level: 'high' };
    mockQuery
      .mockResolvedValueOnce({ rows: [highRow] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const res = await request(app).get('/compliance/reports?risk_level=high');

    expect(res.status).toBe(200);
    expect(res.body.data[0].risk_level).toBe('high');

    // Both DB calls must include the risk_level param
    const mainParams = mockQuery.mock.calls[0][1];
    expect(mainParams).toContain('high');
  });

  it('filters by ?risk_level=minimal (EU AI Act — not "low")', async () => {
    const minimalRow = { ...REPORT_ROW, risk_level: 'minimal' };
    mockQuery
      .mockResolvedValueOnce({ rows: [minimalRow] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const res = await request(app).get('/compliance/reports?risk_level=minimal');

    expect(res.status).toBe(200);
    expect(res.body.data[0].risk_level).toBe('minimal');
    const mainParams = mockQuery.mock.calls[0][1];
    expect(mainParams).toContain('minimal');
  });

  it('filters by ?report_type=eu_ai_act', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_ROW] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const res = await request(app).get('/compliance/reports?report_type=eu_ai_act');

    expect(res.status).toBe(200);
    const mainParams = mockQuery.mock.calls[0][1];
    expect(mainParams).toContain('eu_ai_act');
  });

  it('supports combined risk_level + report_type filters', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_ROW] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const res = await request(app)
      .get('/compliance/reports?risk_level=limited&report_type=eu_ai_act');

    expect(res.status).toBe(200);
    const mainParams = mockQuery.mock.calls[0][1];
    expect(mainParams).toContain('limited');
    expect(mainParams).toContain('eu_ai_act');
  });

  it('respects custom page and limit', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_ROW] })
      .mockResolvedValueOnce({ rows: [{ count: '42' }] });

    const res = await request(app).get('/compliance/reports?page=2&limit=10');

    expect(res.status).toBe(200);
    expect(res.body.meta.page).toBe(2);
    expect(res.body.meta.limit).toBe(10);
    expect(res.body.meta.pages).toBe(5); // ceil(42/10)
  });

  it('caps limit at 100', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const res = await request(app).get('/compliance/reports?limit=999');

    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(100);
  });

  it('runs main query and count query in parallel (Promise.all)', async () => {
    // Both queries resolve immediately — we just verify both are called
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_ROW] })
      .mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const res = await request(app).get('/compliance/reports');

    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('returns 500 on DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection pool exhausted'));

    const res = await request(app).get('/compliance/reports');

    expect(res.status).toBe(500);
    expect(res.body.title).toBe('Internal Server Error');
  });
});

// ─── POST /compliance/reports ─────────────────────────────────────────────────
describe('POST /compliance/reports', () => {
  it('creates a report with risk_level=limited and returns 201', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_ROW] })   // INSERT RETURNING
      .mockResolvedValueOnce({ rows: [] });              // audit log

    const res = await request(app)
      .post('/compliance/reports')
      .send({ risk_level: 'limited' });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('rpt-001');
    expect(res.body.data.report_type).toBe('eu_ai_act');
  });

  it('creates a report with risk_level=minimal', async () => {
    const minimalRow = { ...REPORT_ROW, risk_level: 'minimal' };
    mockQuery
      .mockResolvedValueOnce({ rows: [minimalRow] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/compliance/reports')
      .send({ risk_level: 'minimal' });

    expect(res.status).toBe(201);
    expect(res.body.data.risk_level).toBe('minimal');
  });

  it('creates a report with risk_level=high', async () => {
    const highRow = { ...REPORT_ROW, risk_level: 'high' };
    mockQuery
      .mockResolvedValueOnce({ rows: [highRow] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/compliance/reports')
      .send({ risk_level: 'high' });

    expect(res.status).toBe(201);
    expect(res.body.data.risk_level).toBe('high');
  });

  it('defaults report_type to eu_ai_act', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post('/compliance/reports')
      .send({ risk_level: 'limited' });

    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[1][2]).toBe('eu_ai_act'); // 3rd param is report_type
  });

  it('accepts optional workflow_id when it belongs to tenant', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'wf-001' }] })  // workflow validation
      .mockResolvedValueOnce({ rows: [REPORT_ROW] })          // INSERT
      .mockResolvedValueOnce({ rows: [] });                   // audit log

    const res = await request(app)
      .post('/compliance/reports')
      .send({ risk_level: 'limited', workflow_id: 'wf-001' });

    expect(res.status).toBe(201);
    // workflow validation query must have checked tenant_id
    const wfCheck = mockQuery.mock.calls[0];
    expect(wfCheck[1]).toEqual(['wf-001', 'tenant-abc']);
  });

  it('returns 404 when workflow_id does not belong to tenant', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // workflow not found

    const res = await request(app)
      .post('/compliance/reports')
      .send({ risk_level: 'limited', workflow_id: 'wf-other' });

    expect(res.status).toBe(404);
    expect(res.body.detail).toContain('wf-other');
    // INSERT must NOT have been called
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('accepts optional findings and recommendations', async () => {
    const findings = { issues: ['AI decision not logged'] };
    const recommendations = ['Enable audit trail', 'Add human oversight'];
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/compliance/reports')
      .send({ risk_level: 'high', findings, recommendations });

    expect(res.status).toBe(201);
    const insertCall = mockQuery.mock.calls[0];
    // findings and recommendations are JSON-stringified before insert
    expect(insertCall[1][4]).toBe(JSON.stringify(findings));
    expect(insertCall[1][5]).toBe(JSON.stringify(recommendations));
  });

  it('accepts optional expires_at', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post('/compliance/reports')
      .send({ risk_level: 'limited', expires_at: '2027-01-01T00:00:00Z' });

    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[1][6]).toBe('2027-01-01T00:00:00Z');
  });

  it('returns 400 when risk_level is missing', async () => {
    const res = await request(app)
      .post('/compliance/reports')
      .send({ report_type: 'eu_ai_act' });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/risk_level is required/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid risk_level "low" (approvals risk_level, wrong here)', async () => {
    const res = await request(app)
      .post('/compliance/reports')
      .send({ risk_level: 'low' });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/minimal|limited|high/);
  });

  it('returns 400 for invalid risk_level "critical"', async () => {
    const res = await request(app)
      .post('/compliance/reports')
      .send({ risk_level: 'critical' });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/minimal|limited|high/);
  });

  it('returns 400 for invalid risk_level "medium"', async () => {
    const res = await request(app)
      .post('/compliance/reports')
      .send({ risk_level: 'medium' });

    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/minimal|limited|high/);
  });

  it('writes audit log with compliance.report.create action', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post('/compliance/reports')
      .send({ risk_level: 'limited' });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const auditCall = mockQuery.mock.calls[1];
    expect(auditCall[0]).toContain('INSERT INTO audit_logs');
    expect(auditCall[1]).toContain('compliance.report.create');
  });

  it('sets generated_by to "compliance" in INSERT', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post('/compliance/reports')
      .send({ risk_level: 'high' });

    const insertQuery = mockQuery.mock.calls[0][0];
    expect(insertQuery).toContain("'compliance'");
  });

  it('returns 500 on DB error during INSERT', async () => {
    mockQuery.mockRejectedValueOnce(new Error('unique violation'));

    const res = await request(app)
      .post('/compliance/reports')
      .send({ risk_level: 'limited' });

    expect(res.status).toBe(500);
  });
});

// ─── GET /compliance/reports/:id ─────────────────────────────────────────────
describe('GET /compliance/reports/:id', () => {
  it('returns report detail with workflow fields', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_DETAIL] })
      .mockResolvedValueOnce({ rows: AUDIT_TRAIL });

    const res = await request(app).get('/compliance/reports/rpt-001');

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('rpt-001');
    expect(res.body.data.workflow_title).toBe('Daily Health Check');
    expect(res.body.data.workflow_goal).toBe('Monitor system health');
  });

  it('includes audit_trail array in response', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_DETAIL] })
      .mockResolvedValueOnce({ rows: AUDIT_TRAIL });

    const res = await request(app).get('/compliance/reports/rpt-001');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.audit_trail)).toBe(true);
    expect(res.body.audit_trail).toHaveLength(1);
    expect(res.body.audit_trail[0].action).toBe('compliance.report.create');
  });

  it('returns empty audit_trail when no audit log entries exist', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_DETAIL] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/compliance/reports/rpt-001');

    expect(res.status).toBe(200);
    expect(res.body.audit_trail).toEqual([]);
  });

  it('fetches at most 20 audit_log entries (LIMIT 20)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_DETAIL] })
      .mockResolvedValueOnce({ rows: AUDIT_TRAIL });

    await request(app).get('/compliance/reports/rpt-001');

    const auditQuery = mockQuery.mock.calls[1][0];
    expect(auditQuery).toContain('LIMIT 20');
  });

  it('scopes audit_trail query to correct entity_type and entity_id', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_DETAIL] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).get('/compliance/reports/rpt-001');

    const auditQuery = mockQuery.mock.calls[1];
    expect(auditQuery[0]).toContain("entity_type = 'compliance_report'");
    expect(auditQuery[1]).toContain('tenant-abc');
    expect(auditQuery[1]).toContain('rpt-001');
  });

  it('includes approved_by_name and approved_by_email from JOIN', async () => {
    const approvedRow = {
      ...REPORT_DETAIL,
      approved_by:       'user-002',
      approved_by_name:  'Anna Müller',
      approved_by_email: 'anna@realsync.io',
    };
    mockQuery
      .mockResolvedValueOnce({ rows: [approvedRow] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/compliance/reports/rpt-001');

    expect(res.status).toBe(200);
    expect(res.body.data.approved_by_name).toBe('Anna Müller');
    expect(res.body.data.approved_by_email).toBe('anna@realsync.io');
  });

  it('returns 404 when report does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/compliance/reports/nonexistent');

    expect(res.status).toBe(404);
    expect(res.body.detail).toContain('nonexistent');
  });

  it('enforces tenant isolation — 404 for cross-tenant access', async () => {
    // SELECT returns nothing because tenant_id mismatch
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get('/compliance/reports/rpt-other');

    expect(res.status).toBe(404);
    // audit_trail query must NOT have been called
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('passes id and tenant_id to detail query', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_DETAIL] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).get('/compliance/reports/rpt-001');

    const detailCall = mockQuery.mock.calls[0];
    expect(detailCall[1]).toEqual(['rpt-001', 'tenant-abc']);
  });

  it('audit_trail entries are ordered by created_at DESC', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [REPORT_DETAIL] })
      .mockResolvedValueOnce({ rows: AUDIT_TRAIL });

    await request(app).get('/compliance/reports/rpt-001');

    const auditQuery = mockQuery.mock.calls[1][0];
    expect(auditQuery).toContain('ORDER BY created_at DESC');
  });

  it('returns 500 on DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('replica lag'));

    const res = await request(app).get('/compliance/reports/rpt-001');

    expect(res.status).toBe(500);
    expect(res.body.title).toBe('Internal Server Error');
  });
});
