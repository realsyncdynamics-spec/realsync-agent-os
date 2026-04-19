'use strict';

/**
 * Invoice Management Routes (Eingangsrechnungen)
 * RealSyncDynamics Agent-OS
 *
 * Assumes req.user is populated by JWT middleware upstream (tenant_id, user_id, role).
 */

const express = require('express');
const pool    = require('../db');

const router = express.Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_PAGE_SIZE    = 100;
const EXPORT_MAX_ROWS  = 1000;
const EXPORT_MAX_DAYS  = 366;

// Roles permitted to export
const EXPORT_ROLES = new Set(['admin', 'finance_approver']);
// Roles permitted to delete
const DELETE_ROLES = new Set(['admin']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Structured logger */
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

/** RFC 9457 problem detail response */
function problem(res, status, title, detail, type = null) {
  return res.status(status).json({
    type:   type ?? `https://realsync.io/problems/${status}`,
    title,
    status,
    detail,
  });
}

/** Parse a positive integer from a string, or return the fallback */
function parsePositiveInt(val, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** ISO date string → Date, or null if invalid */
function parseDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Generate a CSV string from an array of row objects.
 * Columns are derived from the first row's keys.
 */
function rowsToCsv(rows) {
  if (!rows.length) return '';

  const columns = Object.keys(rows[0]);
  const escape  = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const header = columns.map(escape).join(',');
  const body   = rows.map((row) => columns.map((col) => escape(row[col])).join(','));
  return [header, ...body].join('\r\n');
}

// ---------------------------------------------------------------------------
// GET /api/invoices
// Paginated invoice list with filters.
// Keyset pagination on (invoice_date DESC, id DESC).
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const tenantId = req.user?.tenant_id;
  if (!tenantId) return problem(res, 401, 'Unauthorized', 'Missing tenant context.');

  const {
    status,
    vendor_name,
    date_from,
    date_to,
    cost_center,
    limit: limitRaw,
    cursor_date,
    cursor_id,
  } = req.query;

  const limit = Math.min(parsePositiveInt(limitRaw, 25), MAX_PAGE_SIZE);

  const params  = [tenantId];
  const filters = ['i.tenant_id = $1', "i.status != 'deleted'"];

  if (status) {
    params.push(status);
    filters.push(`i.status = $${params.length}`);
  }
  if (vendor_name) {
    params.push(`%${vendor_name}%`);
    filters.push(`i.vendor_name ILIKE $${params.length}`);
  }
  if (date_from) {
    const d = parseDate(date_from);
    if (!d) return problem(res, 400, 'Bad Request', 'Invalid date_from format.');
    params.push(d.toISOString());
    filters.push(`i.invoice_date >= $${params.length}`);
  }
  if (date_to) {
    const d = parseDate(date_to);
    if (!d) return problem(res, 400, 'Bad Request', 'Invalid date_to format.');
    params.push(d.toISOString());
    filters.push(`i.invoice_date <= $${params.length}`);
  }
  if (cost_center) {
    params.push(cost_center);
    filters.push(`i.cost_center = $${params.length}`);
  }

  // Keyset cursor
  if (cursor_date && cursor_id) {
    const d = parseDate(cursor_date);
    if (!d) return problem(res, 400, 'Bad Request', 'Invalid cursor_date format.');
    params.push(d.toISOString());
    params.push(cursor_id);
    filters.push(
      `(i.invoice_date, i.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
    );
  }

  const where = filters.join(' AND ');
  params.push(limit + 1); // fetch one extra to detect next page

  const sql = `
    SELECT
      i.id,
      i.vendor_name,
      i.invoice_number,
      i.invoice_date,
      i.due_date,
      i.gross_amount_eur,
      i.net_amount_eur,
      i.vat_amount_eur,
      i.currency,
      i.status,
      i.cost_center,
      i.payment_reference,
      i.ai_extracted,
      i.ai_model,
      i.ai_confidence,
      i.retention_until,
      i.created_at,
      i.updated_at
    FROM invoices i
    WHERE ${where}
    ORDER BY i.invoice_date DESC, i.id DESC
    LIMIT $${params.length}
  `;

  try {
    const { rows } = await pool.query(sql, params);

    const hasMore = rows.length > limit;
    const items   = hasMore ? rows.slice(0, limit) : rows;

    const nextCursor = hasMore
      ? { cursor_date: items[items.length - 1].invoice_date, cursor_id: items[items.length - 1].id }
      : null;

    return res.json({ items, next_cursor: nextCursor, limit });
  } catch (err) {
    logError('invoices.list.failed', err, { tenantId });
    return problem(res, 500, 'Internal Server Error', 'Failed to retrieve invoices.');
  }
});

// ---------------------------------------------------------------------------
// GET /api/invoices/stats
// ---------------------------------------------------------------------------
router.get('/stats', async (req, res) => {
  const tenantId = req.user?.tenant_id;
  if (!tenantId) return problem(res, 401, 'Unauthorized', 'Missing tenant context.');

  const sql = `
    SELECT
      COUNT(*)                                                         AS total_count,
      COALESCE(SUM(gross_amount_eur), 0)                              AS total_gross_eur,
      COUNT(*) FILTER (WHERE status = 'pending_approval')             AS pending_approval_count,
      COALESCE(
        SUM(gross_amount_eur) FILTER (
          WHERE date_trunc('month', invoice_date) = date_trunc('month', NOW())
        ), 0
      )                                                                AS this_month_gross_eur
    FROM invoices
    WHERE tenant_id = $1
      AND status != 'deleted'
  `;

  try {
    const { rows } = await pool.query(sql, [tenantId]);
    const row = rows[0];
    return res.json({
      total_count:            parseInt(row.total_count, 10),
      total_gross_eur:        parseFloat(row.total_gross_eur),
      pending_approval_count: parseInt(row.pending_approval_count, 10),
      this_month_gross_eur:   parseFloat(row.this_month_gross_eur),
    });
  } catch (err) {
    logError('invoices.stats.failed', err, { tenantId });
    return problem(res, 500, 'Internal Server Error', 'Failed to retrieve invoice stats.');
  }
});

// ---------------------------------------------------------------------------
// GET /api/invoices/export/:id  — poll export job status
// Placed before /:id so Express resolves it correctly.
// ---------------------------------------------------------------------------
router.get('/export/:id', async (req, res) => {
  const tenantId  = req.user?.tenant_id;
  const exportId  = req.params.id;
  if (!tenantId) return problem(res, 401, 'Unauthorized', 'Missing tenant context.');

  try {
    const { rows } = await pool.query(
      `SELECT id, status, file_url, created_at, completed_at, error_message
         FROM invoice_exports
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [exportId, tenantId]
    );

    if (!rows.length) return problem(res, 404, 'Not Found', 'Export job not found.');

    const job = rows[0];
    return res.json({
      export_id:    job.id,
      status:       job.status,
      file_url:     job.status === 'completed' ? job.file_url : null,
      created_at:   job.created_at,
      completed_at: job.completed_at ?? null,
      error_message: job.error_message ?? null,
    });
  } catch (err) {
    logError('invoices.export.poll.failed', err, { tenantId, exportId });
    return problem(res, 500, 'Internal Server Error', 'Failed to poll export status.');
  }
});

// ---------------------------------------------------------------------------
// GET /api/invoices/:id  — single invoice with approval details
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  const tenantId  = req.user?.tenant_id;
  const invoiceId = req.params.id;
  if (!tenantId) return problem(res, 401, 'Unauthorized', 'Missing tenant context.');

  const sql = `
    SELECT
      i.id,
      i.vendor_name,
      i.vendor_address,
      i.vendor_tax_id,
      i.invoice_number,
      i.invoice_date,
      i.due_date,
      i.gross_amount_eur,
      i.net_amount_eur,
      i.vat_amount_eur,
      i.vat_rate,
      i.currency,
      i.status,
      i.cost_center,
      i.payment_reference,
      i.description,
      i.file_url,
      i.ai_extracted,
      i.ai_model,
      i.ai_confidence,
      i.retention_until,
      i.created_at,
      i.updated_at,
      -- Approval details (may be null)
      ia.id               AS approval_id,
      ia.approver_user_id,
      ia.decision         AS approval_decision,
      ia.comment          AS approval_comment,
      ia.decided_at       AS approval_decided_at,
      ia.requested_at     AS approval_requested_at
    FROM invoices i
    LEFT JOIN invoice_approvals ia ON ia.invoice_id = i.id
    WHERE i.id = $1
      AND i.tenant_id = $2
      AND i.status != 'deleted'
    ORDER BY ia.requested_at DESC
    LIMIT 1
  `;

  try {
    const { rows } = await pool.query(sql, [invoiceId, tenantId]);
    if (!rows.length) return problem(res, 404, 'Not Found', 'Invoice not found.');

    const row = rows[0];
    const invoice = {
      id:               row.id,
      vendor_name:      row.vendor_name,
      vendor_address:   row.vendor_address,
      vendor_tax_id:    row.vendor_tax_id,
      invoice_number:   row.invoice_number,
      invoice_date:     row.invoice_date,
      due_date:         row.due_date,
      gross_amount_eur: row.gross_amount_eur,
      net_amount_eur:   row.net_amount_eur,
      vat_amount_eur:   row.vat_amount_eur,
      vat_rate:         row.vat_rate,
      currency:         row.currency,
      status:           row.status,
      cost_center:      row.cost_center,
      payment_reference: row.payment_reference,
      description:      row.description,
      file_url:         row.file_url,
      ai_extracted:     row.ai_extracted,
      ai_model:         row.ai_model,
      ai_confidence:    row.ai_confidence,
      retention_until:  row.retention_until,
      created_at:       row.created_at,
      updated_at:       row.updated_at,
      approval: row.approval_id
        ? {
            id:           row.approval_id,
            approver_user_id: row.approver_user_id,
            decision:     row.approval_decision,
            comment:      row.approval_comment,
            decided_at:   row.approval_decided_at,
            requested_at: row.approval_requested_at,
          }
        : null,
    };

    return res.json(invoice);
  } catch (err) {
    logError('invoices.get.failed', err, { tenantId, invoiceId });
    return problem(res, 500, 'Internal Server Error', 'Failed to retrieve invoice.');
  }
});

// ---------------------------------------------------------------------------
// POST /api/invoices/export  — create export job (synchronous CSV, max 1000 rows)
// ---------------------------------------------------------------------------
router.post('/export', async (req, res) => {
  const tenantId = req.user?.tenant_id;
  const userId   = req.user?.user_id;
  const role     = req.user?.role;

  if (!tenantId) return problem(res, 401, 'Unauthorized', 'Missing tenant context.');
  if (!EXPORT_ROLES.has(role)) {
    return problem(res, 403, 'Forbidden', 'Only admin or finance_approver may export invoices.');
  }

  const { date_from, date_to, status, cost_center } = req.body ?? {};

  // Date range validation
  const dFrom = parseDate(date_from);
  const dTo   = parseDate(date_to);

  if (date_from && !dFrom) return problem(res, 400, 'Bad Request', 'Invalid date_from format.');
  if (date_to   && !dTo)   return problem(res, 400, 'Bad Request', 'Invalid date_to format.');

  if (dFrom && dTo) {
    const diffMs   = dTo.getTime() - dFrom.getTime();
    const diffDays = diffMs / 86_400_000;
    if (diffDays < 0)           return problem(res, 400, 'Bad Request', 'date_from must be before date_to.');
    if (diffDays > EXPORT_MAX_DAYS) {
      return problem(res, 400, 'Bad Request', `Date range must not exceed ${EXPORT_MAX_DAYS} days.`);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create export job record (pending)
    const insertResult = await client.query(
      `INSERT INTO invoice_exports (tenant_id, requested_by, status, filters, created_at)
       VALUES ($1, $2, 'processing', $3, NOW())
       RETURNING id`,
      [tenantId, userId, JSON.stringify({ date_from, date_to, status, cost_center })]
    );
    const exportId = insertResult.rows[0].id;

    // Build parameterized query for CSV data
    const csvParams  = [tenantId];
    const csvFilters = ['tenant_id = $1', "status != 'deleted'"];

    if (status) {
      csvParams.push(status);
      csvFilters.push(`status = $${csvParams.length}`);
    }
    if (dFrom) {
      csvParams.push(dFrom.toISOString());
      csvFilters.push(`invoice_date >= $${csvParams.length}`);
    }
    if (dTo) {
      csvParams.push(dTo.toISOString());
      csvFilters.push(`invoice_date <= $${csvParams.length}`);
    }
    if (cost_center) {
      csvParams.push(cost_center);
      csvFilters.push(`cost_center = $${csvParams.length}`);
    }

    csvParams.push(EXPORT_MAX_ROWS);

    const csvSql = `
      SELECT
        id,
        vendor_name,
        invoice_number,
        invoice_date,
        due_date,
        gross_amount_eur,
        net_amount_eur,
        vat_amount_eur,
        currency,
        status,
        cost_center,
        payment_reference,
        ai_extracted,
        ai_model,
        ai_confidence,
        retention_until,
        created_at
      FROM invoices
      WHERE ${csvFilters.join(' AND ')}
      ORDER BY invoice_date DESC, id DESC
      LIMIT $${csvParams.length}
    `;

    const { rows: csvRows } = await client.query(csvSql, csvParams);

    // Generate CSV string with built-in Node.js string ops (no extra deps)
    const csvString = rowsToCsv(csvRows);

    // Store as base64 data URL (RFC 2397)
    const csvBase64 = Buffer.from(csvString, 'utf-8').toString('base64');
    const dataUrl   = `data:text/csv;base64,${csvBase64}`;

    // Mark export completed and store file_url
    await client.query(
      `UPDATE invoice_exports
          SET status       = 'completed',
              file_url     = $2,
              row_count    = $3,
              completed_at = NOW()
        WHERE id = $1`,
      [exportId, dataUrl, csvRows.length]
    );

    await client.query('COMMIT');

    logInfo('invoices.export.completed', { tenantId, exportId, rowCount: csvRows.length });

    return res.status(201).json({ export_id: exportId });
  } catch (err) {
    await client.query('ROLLBACK');
    logError('invoices.export.failed', err, { tenantId });
    return problem(res, 500, 'Internal Server Error', 'Failed to create export job.');
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/invoices/:id  — soft delete, admin only, audit logged
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  const tenantId  = req.user?.tenant_id;
  const userId    = req.user?.user_id;
  const role      = req.user?.role;
  const invoiceId = req.params.id;

  if (!tenantId) return problem(res, 401, 'Unauthorized', 'Missing tenant context.');
  if (!DELETE_ROLES.has(role)) {
    return problem(res, 403, 'Forbidden', 'Only admin may delete invoices.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check the invoice exists and belongs to tenant
    const { rows: existing } = await client.query(
      `SELECT id, status FROM invoices WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [invoiceId, tenantId]
    );

    if (!existing.length) {
      await client.query('ROLLBACK');
      return problem(res, 404, 'Not Found', 'Invoice not found.');
    }
    if (existing[0].status === 'deleted') {
      await client.query('ROLLBACK');
      return problem(res, 409, 'Conflict', 'Invoice is already deleted.');
    }

    // Soft delete
    await client.query(
      `UPDATE invoices
          SET status     = 'deleted',
              updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [invoiceId, tenantId]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (tenant_id, action, actor, metadata, created_at)
       VALUES ($1, 'invoice.deleted', $2, $3, NOW())`,
      [
        tenantId,
        userId,
        JSON.stringify({ invoice_id: invoiceId, role }),
      ]
    );

    await client.query('COMMIT');

    logInfo('invoices.delete.completed', { tenantId, invoiceId, userId });

    return res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    logError('invoices.delete.failed', err, { tenantId, invoiceId });
    return problem(res, 500, 'Internal Server Error', 'Failed to delete invoice.');
  } finally {
    client.release();
  }
});

module.exports = router;
