'use strict';

/**
 * worker-registry.js
 * Single entry point that registers and starts all BullMQ workers for
 * RealSyncDynamics Agent-OS.
 *
 * Usage in app.js:
 *   if (process.env.ENABLE_WORKERS === 'true') {
 *     const workerRegistry = require('./workers/worker-registry');
 *     workerRegistry.start();
 *   }
 */

const { Queue } = require('bullmq');
const winston   = require('winston');

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: { service: 'worker-registry' },
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
// Shared Redis connection
// ---------------------------------------------------------------------------
const redisConnection = {
  url: process.env.REDIS_URL || 'redis://localhost:6379',
};

// ---------------------------------------------------------------------------
// Default job options
// ---------------------------------------------------------------------------
const defaultJobOptions = {
  removeOnComplete: { count: 100 },
  removeOnFail    : { count: 500 },
};

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

/** @type {Queue[]} */
const queues = [];

/** @type {import('bullmq').Worker[]} */
const workers = [];

// ---------------------------------------------------------------------------
// start()
// ---------------------------------------------------------------------------

/**
 * Initializes all workers and their associated queues.
 * Adds repeatable jobs where required.
 *
 * @returns {Promise<void>}
 */
async function start() {
  logger.info('Worker registry starting…');

  // ── 1. approval-expiry ──────────────────────────────────────────────────

  // Create the queue
  const approvalExpiryQueue = new Queue('approval-expiry', {
    connection       : redisConnection,
    defaultJobOptions: defaultJobOptions,
  });
  queues.push(approvalExpiryQueue);

  // Register a repeatable job that fires every 5 minutes
  await approvalExpiryQueue.add(
    'sweep',
    {}, // No payload needed — the worker queries the DB itself
    {
      repeat: {
        every: 5 * 60 * 1000, // 5 minutes in milliseconds
      },
      removeOnComplete: { count: 100 },
      removeOnFail    : { count: 500 },
    },
  );
  logger.info('Repeatable job registered', {
    queue   : 'approval-expiry',
    interval: '5 minutes',
  });

  // Import and register the worker (worker registers its own BullMQ Worker
  // instance internally and exports it for lifecycle management here)
  const approvalExpiryWorker = require('./approval-expiry.worker');
  workers.push(approvalExpiryWorker.worker);
  logger.info('Worker registered', { queue: 'approval-expiry' });

  // ── 2. agent-tasks (placeholder) ────────────────────────────────────────
  // The agent-tasks queue is already consumed by the agent execution engine.
  // We define the queue here so the registry owns the connection reference
  // and can tear it down cleanly on stop().

  const agentTasksQueue = new Queue('agent-tasks', {
    connection       : redisConnection,
    defaultJobOptions: defaultJobOptions,
  });
  queues.push(agentTasksQueue);

  logger.info('Placeholder queue registered (worker managed by agents)', {
    queue: 'agent-tasks',
  });

  // ── Done ─────────────────────────────────────────────────────────────────
  logger.info('Worker registry started', {
    workers: workers.length,
    queues : queues.map((q) => q.name),
  });
}

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

/**
 * Gracefully closes all workers and queues managed by this registry.
 *
 * @returns {Promise<void>}
 */
async function stop() {
  logger.info('Worker registry stopping…');

  // Close workers first so they finish in-flight jobs before queue closes
  await Promise.allSettled(
    workers.map(async (w) => {
      try {
        await w.close();
        logger.info('Worker closed', { name: w.name });
      } catch (err) {
        logger.error('Error closing worker', { name: w.name, error: err.message });
      }
    }),
  );

  // Then close queues
  await Promise.allSettled(
    queues.map(async (q) => {
      try {
        await q.close();
        logger.info('Queue closed', { name: q.name });
      } catch (err) {
        logger.error('Error closing queue', { name: q.name, error: err.message });
      }
    }),
  );

  logger.info('Worker registry stopped');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { start, stop };
