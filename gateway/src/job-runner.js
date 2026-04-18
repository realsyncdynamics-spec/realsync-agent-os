'use strict';

/**
 * OpenClaw Gateway — Job Runner
 * Spawns scripts (bash/powershell), tracks output and status,
 * and emits events so the WebSocket layer can stream lines to subscribers.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const logger = require('./logger');

const MAX_JOBS = 100;
const DEFAULT_TIMEOUT_MS = parseInt(process.env.MAX_JOB_TIMEOUT_MS, 10) || 300_000; // 5 min
const ALLOWED_EXTENSIONS = (process.env.ALLOWED_SCRIPT_EXTENSIONS || '.sh,.ps1,.py')
  .split(',')
  .map((e) => e.trim().toLowerCase());

class JobRunner extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, JobRecord>} */
    this.jobs = new Map();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Queue and immediately start a job.
   * @param {string} jobId
   * @param {string} scriptPath  Absolute path to the script file.
   * @param {Object} params      Key-value pairs passed as env vars to the child.
   * @returns {Promise<void>}    Resolves when the job finishes (or times out).
   */
  async run(jobId, scriptPath, params = {}) {
    this._evict();

    const record = {
      id: jobId,
      scriptPath,
      params,
      status: 'running',
      output: [],
      exitCode: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      pid: null,
    };

    this.jobs.set(jobId, record);
    logger.info(`Job ${jobId} started: ${scriptPath}`);

    return new Promise((resolve) => {
      const { cmd, args } = this._buildArgs(scriptPath, params);
      const env = { ...process.env, ...this._paramsToEnv(params) };

      let child;
      try {
        child = spawn(cmd, args, {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (spawnErr) {
        logger.error(`Job ${jobId} spawn error: ${spawnErr.message}`);
        record.status = 'failed';
        record.exitCode = -1;
        record.completedAt = new Date().toISOString();
        record.output.push(`[ERROR] Spawn failed: ${spawnErr.message}`);
        this.emit('job:line', { jobId, line: record.output[0] });
        this.emit('job:done', { jobId, exitCode: -1, output: record.output.join('\n') });
        return resolve();
      }

      record.pid = child.pid;

      // Timeout watchdog
      const timer = setTimeout(() => {
        logger.warn(`Job ${jobId} timed out after ${DEFAULT_TIMEOUT_MS}ms — killing`);
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (_) { /* already dead */ }
        }, 3000);
      }, DEFAULT_TIMEOUT_MS);

      // Line collector helper
      const collectLines = (stream, prefix) => {
        let buffer = '';
        stream.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete last segment
          for (const line of lines) {
            const tagged = prefix ? `[${prefix}] ${line}` : line;
            record.output.push(tagged);
            this.emit('job:line', { jobId, line: tagged });
          }
        });
        stream.on('end', () => {
          if (buffer.length > 0) {
            const tagged = prefix ? `[${prefix}] ${buffer}` : buffer;
            record.output.push(tagged);
            this.emit('job:line', { jobId, line: tagged });
          }
        });
      };

      collectLines(child.stdout, null);
      collectLines(child.stderr, 'STDERR');

      child.on('error', (err) => {
        logger.error(`Job ${jobId} process error: ${err.message}`);
        record.status = 'failed';
      });

      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const exitCode = code !== null ? code : (signal ? 1 : 0);
        record.exitCode = exitCode;
        record.status = exitCode === 0 ? 'done' : 'failed';
        record.completedAt = new Date().toISOString();

        logger.info(`Job ${jobId} finished: exit=${exitCode} signal=${signal}`);
        this.emit('job:done', {
          jobId,
          exitCode,
          output: record.output.join('\n'),
        });
        resolve();
      });
    });
  }

  /**
   * Get a single job record.
   * @param {string} jobId
   * @returns {JobRecord|null}
   */
  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  /**
   * List the most recent 50 jobs (newest first).
   * @returns {JobRecord[]}
   */
  listJobs() {
    const all = [...this.jobs.values()];
    all.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    return all.slice(0, 50);
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Detect the shell to use based on the OS and file extension.
   * @param {string} scriptPath
   * @returns {{ cmd: string, shell: string }}
   */
  _detectShell(scriptPath) {
    const ext = path.extname(scriptPath).toLowerCase();
    const isWindows = os.platform() === 'win32';

    if (ext === '.ps1') {
      return { shell: 'powershell', cmd: 'powershell.exe' };
    }
    if (ext === '.py') {
      return { shell: 'python', cmd: isWindows ? 'python' : 'python3' };
    }
    // Default: bash / sh
    return { shell: 'bash', cmd: isWindows ? 'bash' : '/bin/bash' };
  }

  /**
   * Build the command + arguments array for spawn.
   * @param {string} scriptPath
   * @param {Object} params
   * @returns {{ cmd: string, args: string[] }}
   */
  _buildArgs(scriptPath, params = {}) {
    const { cmd, shell } = this._detectShell(scriptPath);

    let args;
    if (shell === 'powershell') {
      // -NonInteractive -ExecutionPolicy Bypass -File <script> [key=value ...]
      args = [
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath,
        ...Object.entries(params).map(([k, v]) => `-${k} "${v}"`),
      ];
    } else if (shell === 'python') {
      args = [scriptPath];
    } else {
      // bash -e <script>
      args = ['-e', scriptPath];
    }

    return { cmd, args };
  }

  /**
   * Convert a params object to env-var-friendly key=value pairs.
   * Prefixes each key with OPENCLAW_ to avoid collisions.
   * @param {Object} params
   * @returns {Object}
   */
  _paramsToEnv(params) {
    const env = {};
    for (const [k, v] of Object.entries(params)) {
      const safe = `OPENCLAW_${k.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
      env[safe] = String(v);
    }
    return env;
  }

  /**
   * Validate that a script path is allowed (extension check).
   * @param {string} scriptPath
   * @returns {{ ok: boolean, reason?: string }}
   */
  validateScript(scriptPath) {
    const ext = path.extname(scriptPath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return {
        ok: false,
        reason: `Script extension "${ext}" is not in ALLOWED_SCRIPT_EXTENSIONS (${ALLOWED_EXTENSIONS.join(', ')})`,
      };
    }
    return { ok: true };
  }

  /**
   * FIFO eviction — remove oldest jobs if we exceed MAX_JOBS.
   */
  _evict() {
    if (this.jobs.size < MAX_JOBS) return;
    const sorted = [...this.jobs.entries()].sort(
      ([, a], [, b]) => new Date(a.startedAt) - new Date(b.startedAt)
    );
    const toRemove = sorted.slice(0, this.jobs.size - MAX_JOBS + 1);
    for (const [id] of toRemove) {
      this.jobs.delete(id);
      logger.debug(`Evicted job ${id} from queue`);
    }
  }
}

// Singleton
const runner = new JobRunner();
module.exports = runner;
