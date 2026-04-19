#!/usr/bin/env node
/**
 * RealSyncDynamics Agent-OS — Database Migration Runner
 *
 * Runs schema + all migrations in order.
 * Used as Cloud Run Job before each backend deploy.
 *
 * Usage:
 *   node src/db/migrate.js
 *   NODE_ENV=production node src/db/migrate.js
 *
 * Exit codes:
 *   0 — success
 *   1 — migration failed (deploy should be aborted)
 */

'use strict';

require('dotenv').config();

const { Pool }   = require('pg');
const fs         = require('fs');
const path       = require('path');

// ── Logger (no winston dep — this runs as a standalone job) ──
const log  = (msg, meta = {}) =>
  console.log(JSON.stringify({ level: 'info',  message: msg, ...meta, ts: new Date().toISOString() }));
const err  = (msg, meta = {}) =>
  console.error(JSON.stringify({ level: 'error', message: msg, ...meta, ts: new Date().toISOString() }));

// ── DB Connection ─────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }   // Cloud SQL via Cloud Run
    : false,
  connectionTimeoutMillis: 10_000,
  max: 3,
});

// ── Migration Tracking Table ──────────────────────────────────
const ENSURE_TRACKING = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id          SERIAL      PRIMARY KEY,
    filename    TEXT        NOT NULL UNIQUE,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checksum    TEXT        NOT NULL
  );
`;

// ── File Order ───────────────────────────────────────────────
// schema.sql runs first (idempotent — uses CREATE TABLE IF NOT EXISTS)
// then migrations in numeric order
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function getChecksum(content) {
  const { createHash } = require('crypto');
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

async function isApplied(client, filename) {
  const { rows } = await client.query(
    'SELECT id FROM schema_migrations WHERE filename = $1',
    [filename]
  );
  return rows.length > 0;
}

async function markApplied(client, filename, checksum) {
  await client.query(
    'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING',
    [filename, checksum]
  );
}

async function runFile(client, filePath, label) {
  const sql = fs.readFileSync(filePath, 'utf8');
  const checksum = await getChecksum(sql);

  if (await isApplied(client, label)) {
    log(`Skipping (already applied): ${label}`);
    return false;
  }

  log(`Applying: ${label}`);
  const t0 = Date.now();

  // Execute the entire file as one statement block
  await client.query(sql);
  await markApplied(client, label, checksum);

  log(`Applied: ${label}`, { duration_ms: Date.now() - t0, checksum });
  return true;
}

async function main() {
  log('RealSync DB Migration Runner starting', {
    database: process.env.DATABASE_URL?.replace(/:\/\/.*@/, '://***@') || 'not set',
    environment: process.env.NODE_ENV || 'development',
  });

  const client = await pool.connect();

  try {
    // Enable pgcrypto for gen_random_uuid()
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
    log('pgcrypto extension: ok');

    // Create migration tracking table
    await client.query(ENSURE_TRACKING);
    log('schema_migrations table: ok');

    let applied = 0;

    // 1. Base schema
    if (fs.existsSync(SCHEMA_FILE)) {
      const wasApplied = await runFile(client, SCHEMA_FILE, 'schema.sql');
      if (wasApplied) applied++;
    } else {
      log('schema.sql not found — skipping base schema');
    }

    // 2. Numbered migrations in order
    if (fs.existsSync(MIGRATIONS_DIR)) {
      const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();                        // lexicographic → 001, 002, 003 ...

      for (const file of files) {
        const filePath = path.join(MIGRATIONS_DIR, file);
        const wasApplied = await runFile(client, filePath, file);
        if (wasApplied) applied++;
      }
    }

    log('Migration complete', { applied, total_checked: applied });

  } catch (e) {
    err('Migration failed', { error: e.message, stack: e.stack });
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().then(() => {
  if (process.exitCode === 1) {
    process.exit(1);
  }
  log('Migration runner finished successfully');
  process.exit(0);
}).catch((e) => {
  err('Unexpected error', { error: e.message });
  process.exit(1);
});
