'use strict';

/**
 * queues/index.js
 * BullMQ Queue definitions shared across RealSyncDynamics Agent-OS.
 *
 * All queues share:
 *   - A single ioredis connection derived from process.env.REDIS_URL
 *   - Consistent defaultJobOptions for storage hygiene
 *
 * Usage:
 *   const { agentTasks, humanApprovals, deadLetters, approvalExpiry, getQueueStats }
 *     = require('./queues');
 */

const { Queue } = require('bullmq');

// ---------------------------------------------------------------------------
// Redis connection
// ---------------------------------------------------------------------------

/**
 * BullMQ accepts either an ioredis instance or a connection descriptor.
 * We use the descriptor form so BullMQ manages its own pool; callers that
 * need a raw ioredis client should import from `../../db/redis` directly.
 */
const redisConnection = {
  url: process.env.REDIS_URL || 'redis://localhost:6379',
};

// ---------------------------------------------------------------------------
// Shared job options
// ---------------------------------------------------------------------------

const defaultJobOptions = {
  removeOnComplete: { count: 100 },
  removeOnFail    : { count: 500 },
};

// ---------------------------------------------------------------------------
// Queue factory helper
// ---------------------------------------------------------------------------

/**
 * Creates a BullMQ Queue with the shared connection and default options.
 *
 * @param {string} name - Queue name
 * @returns {Queue}
 */
function makeQueue(name) {
  return new Queue(name, {
    connection       : redisConnection,
    defaultJobOptions: defaultJobOptions,
  });
}

// ---------------------------------------------------------------------------
// Named queue exports
// ---------------------------------------------------------------------------

/**
 * agentTasks — Jobs dispatched by the agent execution engine.
 * Each job represents a single agent task to be run by an agent worker.
 * @type {Queue}
 */
const agentTasks = makeQueue('agent-tasks');

/**
 * humanApprovals — Jobs that require a human decision before proceeding.
 * Approval records are stored in the DB; this queue carries notification
 * and reminder payloads only.
 * @type {Queue}
 */
const humanApprovals = makeQueue('human-approvals');

/**
 * deadLetters — Catch-all for jobs that have exhausted all retry attempts.
 * Jobs are moved here automatically via BullMQ's failure pipeline.
 * An alerting worker should monitor this queue and page on-call.
 * @type {Queue}
 */
const deadLetters = makeQueue('dead-letters');

/**
 * approvalExpiry — Hosts the repeatable sweep job that auto-expires stale
 * pending approvals. Managed by worker-registry.js.
 * @type {Queue}
 */
const approvalExpiry = makeQueue('approval-expiry');

// ---------------------------------------------------------------------------
// getQueueStats()
// ---------------------------------------------------------------------------

/**
 * Returns job counts for all managed queues.
 *
 * @returns {Promise<Record<string, {
 *   waiting   : number,
 *   active    : number,
 *   completed : number,
 *   failed    : number,
 *   delayed   : number,
 *   paused    : number,
 * }>>}
 */
async function getQueueStats() {
  const allQueues = [agentTasks, humanApprovals, deadLetters, approvalExpiry];

  const statsEntries = await Promise.all(
    allQueues.map(async (queue) => {
      const [waiting, active, completed, failed, delayed, paused] =
        await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getCompletedCount(),
          queue.getFailedCount(),
          queue.getDelayedCount(),
          queue.getPausedCount(),
        ]);

      return [
        queue.name,
        { waiting, active, completed, failed, delayed, paused },
      ];
    }),
  );

  return Object.fromEntries(statsEntries);
}

// ---------------------------------------------------------------------------
// Graceful shutdown helper
// ---------------------------------------------------------------------------

/**
 * Closes all queue connections. Call during application shutdown.
 *
 * @returns {Promise<void>}
 */
async function closeAll() {
  await Promise.allSettled([
    agentTasks.close(),
    humanApprovals.close(),
    deadLetters.close(),
    approvalExpiry.close(),
  ]);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  agentTasks,
  humanApprovals,
  deadLetters,
  approvalExpiry,
  getQueueStats,
  closeAll,
};
