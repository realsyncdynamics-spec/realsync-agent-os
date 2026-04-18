'use strict';

/**
 * approval-expiry.worker.js
 * BullMQ worker that auto-expires pending approvals for RealSyncDynamics Agent-OS.
 *
 * Runs on a repeatable schedule (every 5 minutes via worker-registry.js).
 * Batch-processes up to 100 pending approvals whose expires_at < NOW(),
 * marks them expired, fails any associated tasks, and writes audit logs.
 */

const { Worker } = require('bullmq');
const winston  = require('winston');
const pool     = require('../../db');

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: { service: 'approval-expiry-worker' },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
  ],
});

// ---------------------------------------------------------------------------
// Redis connection options (shared with queues/index.js via env)
// ---------------------------------------------------------------------------
const redisConnection = {
  url: process.env.REDIS_URL || 'redis://localhost:6379',
};

// ---------------------------------------------------------------------------
// Job processor
// ---------------------------------------------------------------------------

/**
 * Processes a single expiry-sweep job.
 *
 * @param {import('bullmq').Job} job
 * @returns {Promise<{ expired_count: number, task_ids_failed: string[] }>}
 */
async function processApprovalExpiry(job) {
  logger.info('Starting approval expiry sweep', { jobId: job.id });

  const BATCH_SIZE = 100;

  // ------------------------------------------------------------------
  // 1. Fetch expired pending approvals (max BATCH_SIZE)
  // ------------------------------------------------------------------
  const selectResult = await pool.query(
    `SELECT id, task_id, tenant_id
       FROM approvals
      WHERE status = 'pending'
        AND expires_at < NOW()
      LIMIT $1`,
    [BATCH_SIZE],
  );

  const expiredApprovals = selectResult.rows;

  if (expiredApprovals.length === 0) {
    logger.info('No expired approvals found', { jobId: job.id });
    return { expired_count: 0, task_ids_failed: [] };
  }

  logger.info(`Found ${expiredApprovals.length} expired approval(s)`, {
    jobId: job.id,
    count: expiredApprovals.length,
  });

  const taskIdsFailed = [];

  // ------------------------------------------------------------------
  // 2. Process each expired approval inside a DB transaction
  // ------------------------------------------------------------------
  for (const approval of expiredApprovals) {
    const { id: approvalId, task_id: taskId, tenant_id: tenantId } = approval;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // a) Mark approval as expired
      await client.query(
        `UPDATE approvals
            SET status     = 'expired',
                updated_at = NOW()
          WHERE id = $1`,
        [approvalId],
      );

      // b) Fail the associated task (if any)
      if (taskId) {
        await client.query(
          `UPDATE tasks
              SET status     = 'failed',
                  updated_at = NOW(),
                  error      = 'Human approval expired after deadline'
            WHERE id = $1`,
          [taskId],
        );
        taskIdsFailed.push(taskId);
      }

      // c) Write audit log
      await client.query(
        `INSERT INTO audit_logs
               (tenant_id, action, resource, resource_id, details, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenantId,
          'approval_expired',
          'approvals',
          approvalId,
          JSON.stringify({
            approval_id : approvalId,
            task_id     : taskId  || null,
            expired_at  : new Date().toISOString(),
            reason      : 'Automated expiry sweep — deadline exceeded',
          }),
          'success',
        ],
      );

      await client.query('COMMIT');

      logger.info('Approval expired successfully', {
        approvalId,
        taskId: taskId || 'N/A',
        tenantId,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Failed to expire approval — transaction rolled back', {
        approvalId,
        taskId: taskId || 'N/A',
        error: err.message,
        stack: err.stack,
      });
      // Re-throw so BullMQ counts this job attempt as failed
      throw err;
    } finally {
      client.release();
    }
  }

  const result = {
    expired_count  : expiredApprovals.length,
    task_ids_failed: taskIdsFailed,
  };

  logger.info('Approval expiry sweep complete', { jobId: job.id, ...result });
  return result;
}

// ---------------------------------------------------------------------------
// Worker instantiation
// ---------------------------------------------------------------------------

const worker = new Worker(
  'approval-expiry',
  processApprovalExpiry,
  {
    connection : redisConnection,
    concurrency: 1, // Only one expiry sweep runs at a time
  },
);

// ---------------------------------------------------------------------------
// Worker event hooks
// ---------------------------------------------------------------------------

worker.on('completed', (job, result) => {
  logger.info('Job completed', {
    jobId          : job.id,
    expired_count  : result.expired_count,
    task_ids_failed: result.task_ids_failed,
  });
});

worker.on('failed', (job, err) => {
  logger.error('Job failed', {
    jobId : job?.id,
    error : err.message,
    stack : err.stack,
  });
});

worker.on('error', (err) => {
  logger.error('Worker error', { error: err.message, stack: err.stack });
});

worker.on('stalled', (jobId) => {
  logger.warn('Job stalled — will be retried', { jobId });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  logger.info(`${signal} received — shutting down approval-expiry worker`);
  try {
    await worker.close();
    logger.info('Worker closed cleanly');
  } catch (err) {
    logger.error('Error closing worker', { error: err.message });
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Exports (allows worker-registry.js to manage lifecycle)
// ---------------------------------------------------------------------------

module.exports = { worker };
