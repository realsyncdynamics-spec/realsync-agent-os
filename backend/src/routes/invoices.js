'use strict';

/**
 * Invoice Management Routes (Eingangsrechnungen)
 * RealSyncDynamics Agent-OS — Sprint 16 compatible version
 *
 * § 147 AO: 10-year retention obligation.
 * retention_until is stored/returned as a field.
 *
 * Routes:
 *   GET    /invoices              — paginated list with filters
 *   GET    /invoices/export       — CSV/JSON export (date range required)
 *   GET    /invoices/:id          — single invoice detail
 *   POST   /invoices              — create invoice
 *   PATCH  /invoices/:id          — update metadata
 *   DELETE /invoices/:id          — soft-delete (admin only)
 */

const express = require('express');
const pool    = require('../db');

const router = express.Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_PAGE_SIZE   = 100;
const EXPORT_MAX_ROWS = 1000;

// Roles permitted to export / delete
const EXPORT_ROLES = new Set(['admin', 'finance_approver']);
const DELETE_ROLES = new Set(['admin']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logInfo(event, data = {}) {
  console.log(JSON.stringify({ level: 'info', event, ...data, ts: new Date().toISOString() }));
}
function logError(event, err, data = {}) {
  console.error(JSON.stringify({
    level:   'error',
    event,
    message: err?.message ?? String(err),
    stack:   err?.stack   ?? null,
    ...data,
    ts: new Date().toISOString(),
  }));
}

/** RFC 9457 problem detail */
function problem(res, status, title, detail) {
  return res.status(status).json({
    type:   `https://realsync.io/problems/${status}`,
    title,
    status,
    detail,
  });
}

function parsePositiveInt(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

function rowsToCsv(rows) {
  if (!rows.length) return '';
  const cols   = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return s.includes('"') || s.includes(',') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(escape).join(','), ...rows.map(r => cols.map(c => escape(r[c])).join(','))].join('\r\n');
}

// ---------------------------------------------------------------------------
// GET /invoices/export — must be before /:id
// ---------------------------------------------------------------------------
router.get('/export', async (req, res) => {
  const tenantId = req.user?.tenant_id;
  if (!tenantId) return problem(res, 401, 'Unauthorized', 'Missing tenant context.');

  const role = req.user?.role;
  if (!EXPORT_ROLES.has(role)) {
    return problem(res, 403, 'Forbidden', 'Only admin or finance_approver may export invoices.');
  }

  // Date range is required
  if (!req.query.from || !req.query.to) {
    return problem(res, 400, 'Bad Request', "Export requires 'from' and 'to' query parameters.");
  }

  const dFrom = parseDate(req.query.from);
  const dTo   = parseDate(req.query.to);

  if (!dFrom) return problem(res, 400, 'Bad Request', 'Invalid from date format.');
  if (!dTo)   return problem(res, 400, 'Bad Request', 'Invalid to date format.');

  try {
    const params  = [tenantId, dFrom.toISOString(), dTo.toISOString()];
    const sql = `
      SELECT id, vendor_name, invoice_number, invoice_date, due_date,
             amount, currency, status, ai_extracted, ai_confidence,
             retention_until, created_at
      FROM invoices
      WHERE tenant_id = $1
        AND deleted_at IS NULL
        AND invoice_date >= $2
        AND invoice_date <= $3
      ORDER BY invoice_date DESC
      LIMIT ${EXPORT_MAX_ROWS}
    `;

    const { rows } = await pool.query(sql, params);
    const csv = rowsToCsv(rows);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="invoices-export-${Date.now()}.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    logError('invoices.export.failed', err, { tenantId });
    return problem(res, 500, 'Internal Server Error', 'Failed to export invoices.');
  }
});

// ---------------------------------------------------------------------------
// GET /invoices
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const tenantId = req.user?.tenant_id;
  if (!tenantId) return problem(res, 401, 'Unauthorized', 'Missing tenant context.');

  const { status, vendor_name, date_from, date_to } = req.query;
  const page  = parsePositiveInt(req.query.page,  1);
  const limit = Math.min(parsePositiveInt(req.query.limit, 25), MAX_PAGE_SIZE);
  const offset = (page - 1) * limit;

  const params    = [tenantId];
  const filters   = ['tenant_id = $1', 'deleted_at IS NULL'];

  if (status) {
    params.push(status);
    filters.push(`status = $${params.length}`);
  }
  if (vendor_name) {
    params.push(`%${vendor_name}%`);
    filters.push(`vendor_name ILIKE $${params.length}`);
  }
  if (date_from) {
    const d = parseDate(date_from);
    if (!d) return problem(res, 400, 'Bad Request', 'Invalid date_from format.');
    params.push(d.toISOString());
    filters.push(`invoice_date >= $${params.length}`);
  }
  if (date_to) {
    const d = parseDate(date_to);
    if (!d) return problem(res, 400, 'Bad Request', 'Invalid date_to format.');
    params.push(d.toISOString());
    filters.push(`invoice_date <= $${params.length}`);
  }

  const where = filters.join(' AND ');

  try {
    const dataParams  = [...params, limit, offset];
    const countParams = [...params];

    const [dataResult, countResult] = await Promise.all([
      pool.query(
        `SELECT id, vendor_name, invoice_number, invoice_date, due_date,
                amount, currency, status, ai_extracted, ai_confidence,
                retention_until, deleted_at, created_at, updated_at
         FROM invoices
         WHERE ${where}
         ORDER BY invoice_date DESC, id DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        dataParams
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM invoices WHERE ${where}`,
        countParams
      ),
    ]);

    const total = parseInt(countResult.rows[0].total, 10);

    return res.json({
      data: dataResult.rows,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
        has_next: offset + limit < total,
        has_prev: page > 1,
      },
    });
  } catch (err) {
    logError('invoices.list.failed', err, { tenantId });
    return problem(res, 500, 'Internal Server Error', 'Failed to retrieve invoices.');
  }
});

// ---------------------------------------------------------------------------
// GET /invoices/:id
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  const tenantId  = req.user?.tenant_id;
  const invoiceId = req.params.id;
  if (!tenantId) return problem(res, 401, 'Unauthorized', 'Missing tenant context.');

  try {
    const { rows } = await pool.query(
      `SELECT id, vendor_name, invoice_number, invoice_date, due_date,
              amount, currency, status, ai_extracted, ai_confidence,
              retention_until, deleted_at, created_at, updated_at
       FROM invoices
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       LIMIT 1`,
      [invoiceId, tenantId]
    );

    if (!rows.length) return problem(res, 404, 'Not Found', 'Invoice not found.');

    return res.json({ data: rows[0] });
  } catch (err) {
    logError('invoices.get.failed', err, { tenantId, invoiceId });
    return problem(res, 500, 'Internal Server Error', 'Failed to retrieve invoice.');
  }
});

// ---------------------------------------------------------------------------
// POST /invoices
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  const tenantId = req.user?.tenant_id;
  if (!tenantId) return problem(res, 401, 'Unauthorized', 'Missing tenant context.');

  const { vendor_name, amount, currency = 'EUR', invoice_date, invoice_number, due_date } = req.body ?? {};

  // Validation
  if (!vendor_name) return problem(res, 400, 'Bad Request', 'vendor_name is required.');
  if (amount === undefined || amount === null) return problem(res, 400, 'Bad Request', 'amount is required.');
  if (typeof amount === 'number' && amount < 0) return problem(res, 400, 'Bad Request', 'amount must be non-negative.');
  if (!invoice_date) return problem(res, 400, 'Bad Request', 'invoice_date is required.');

  const invDate = parseDate(invoice_date);
  if (!invDate) return problem(res, 400, 'Bad Request', 'Invalid invoice_date format.');

  // § 147 AO: retention_until = invoice_date + 10 years
  const retentionDate = new Date(invDate);
  retentionDate.setFullYear(retentionDate.getFullYear() + 10);
  const retentionUntil = retentionDate.toISOString().slice(0, 10);

  try {
    const { rows } = await pool.query(
      `INSERT INTO invoices
         (tenant_id, vendor_name, invoice_number, invoice_date, due_date,
          amount, currency, status, retention_until, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, NOW(), NOW())
       RETURNING id, vendor_name, invoice_number, invoice_date, due_date,
                 amount, currency, status, ai_extracted, ai_confidence,
                 retention_until, created_at, updated_at`,
      [tenantId, vendor_name, invoice_number || null, invDate.toISOString(),
       due_date || null, amount, currency, retentionUntil]
    );

    logInfo('invoices.create', { tenantId, invoiceId: rows[0]?.id });
    return res.status(201).json({ data: rows[0] });
  } catch (err) {
    logError('invoices.create.failed', err, { tenantId });
    return problem(res, 500, 'Internal Server Error', 'Failed to create invoice.');
  }
});

// ---------------------------------------------------------------------------
// PATCH /invoices/:id
// ---------------------------------------------------------------------------
router.patch('/:id', async (req, res) => {
  const tenantId  = req.user?.tenant_id;
  const invoiceId = req.params.id;
  if (!tenantId) return problem(res, 401, 'Unauthorized', 'Missing tenant context.');

  const allowed = ['vendor_name', 'invoice_number', 'due_date', 'status', 'currency'];
  const updates = [];
  const params  = [];

  for (const field of allowed) {
    if (req.body[field] !== undefined) {
      params.push(req.body[field]);
      updates.push(`${field} = $${params.length}`);
    }
  }

  if (updates.length === 0) {
    return problem(res, 400, 'Bad Request', 'At least one updatable field must be provided.');
  }

  params.push(invoiceId, tenantId);

  try {
    const { rows } = await pool.query(
      `UPDATE invoices
          SET ${updates.join(', ')}, updated_at = NOW()
        WHERE id = $${params.length - 1}
          AND tenant_id = $${params.length}
          AND deleted_at IS NULL
        RETURNING id, vendor_name, invoice_number, invoice_date, due_date,
                  amount, currency, status, retention_until, created_at, updated_at`,
      params
    );

    if (!rows.length) return problem(res, 404, 'Not Found', 'Invoice not found.');
    return res.json({ data: rows[0] });
  } catch (err) {
    logError('invoices.patch.failed', err, { tenantId, invoiceId });
    return problem(res, 500, 'Internal Server Error', 'Failed to update invoice.');
  }
});

// ---------------------------------------------------------------------------
// DELETE /invoices/:id  — soft delete (admin only)
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  const tenantId  = req.user?.tenant_id;
  const role      = req.user?.role;
  const invoiceId = req.params.id;

  if (!tenantId) return problem(res, 401, 'Unauthorized', 'Missing tenant context.');
  if (!DELETE_ROLES.has(role)) {
    return problem(res, 403, 'Forbidden', 'Only admin may delete invoices.');
  }

  try {
    // Check invoice exists
    const { rows: existing } = await pool.query(
      `SELECT id FROM invoices WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [invoiceId, tenantId]
    );

    if (!existing.length) return problem(res, 404, 'Not Found', 'Invoice not found.');

    // Soft delete — sets deleted_at
    await pool.query(
      `UPDATE invoices SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId]
    );

    logInfo('invoices.delete', { tenantId, invoiceId });
    return res.status(204).end();
  } catch (err) {
    logError('invoices.delete.failed', err, { tenantId, invoiceId });
    return problem(res, 500, 'Internal Server Error', 'Failed to delete invoice.');
  }
});

module.exports = router;
