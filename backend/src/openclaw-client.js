// openclaw-client.js
// OpenClaw Remote Execution Gateway — Node.js Client
// Supports HTTP REST + WebSocket streaming

'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');

// Optional WebSocket support — install with: npm install ws
let WebSocket;
try { WebSocket = require('ws'); } catch (_) { WebSocket = null; }

// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS  = 30_000;   // 30 seconds
const MAX_RETRIES         = 3;
const RETRY_DELAY_BASE_MS = 500;      // exponential back-off base

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sleep helper for retry back-off.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Minimal HTTP/HTTPS request wrapper with timeout + JSON support.
 *
 * @param {object} opts
 * @param {string}  opts.method
 * @param {string}  opts.url
 * @param {object}  [opts.headers]
 * @param {object}  [opts.body]        — serialised to JSON if present
 * @param {number}  [opts.timeoutMs]
 * @returns {Promise<{ statusCode: number, body: any }>}
 */
function request({ method, url: rawUrl, headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(rawUrl);
    const isHttps  = parsed.protocol === 'https:';
    const lib      = isHttps ? https : http;
    const payload  = body ? JSON.stringify(body) : null;

    const reqHeaders = {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      ...headers,
    };
    if (payload) reqHeaders['Content-Length'] = Buffer.byteLength(payload);

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers:  reqHeaders,
    };

    const req = lib.request(options, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed_body;
        try { parsed_body = JSON.parse(raw); } catch (_) { parsed_body = raw; }
        resolve({ statusCode: res.statusCode, body: parsed_body });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── OpenClawClient ───────────────────────────────────────────────────────────

class OpenClawClient {
  /**
   * @param {string} gatewayUrl   Base URL of the OpenClaw gateway,
   *                              e.g. "https://gateway.example.com:8443"
   * @param {string} apiKey       API key issued by the gateway
   * @param {object} [options]
   * @param {number} [options.timeoutMs=30000]
   * @param {number} [options.maxRetries=3]
   */
  constructor(gatewayUrl, apiKey, options = {}) {
    if (!gatewayUrl) throw new Error('gatewayUrl is required');
    if (!apiKey)     throw new Error('apiKey is required');

    this.baseUrl    = gatewayUrl.replace(/\/$/, '');
    this.apiKey     = apiKey;
    this.timeoutMs  = options.timeoutMs  ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;

    this._defaultHeaders = {
      'X-API-Key':    this.apiKey,
      'X-Client':     'openclaw-node-client/1.0.0',
    };
  }

  // ── Private: request with retry ───────────────────────────────────────────

  /**
   * Executes an HTTP request with exponential-back-off retry on transient errors.
   * Retries on network errors and 5xx responses (except 501).
   *
   * @param {object} opts   — same as `request()`
   * @returns {Promise<any>}   parsed response body
   * @throws {OpenClawError}
   */
  async _request(opts) {
    const fullOpts = {
      ...opts,
      headers:   { ...this._defaultHeaders, ...(opts.headers || {}) },
      timeoutMs: this.timeoutMs,
    };

    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const { statusCode, body } = await request(fullOpts);

        if (statusCode >= 200 && statusCode < 300) {
          return body;
        }

        // Non-retryable client errors
        if (statusCode >= 400 && statusCode < 500) {
          throw new OpenClawError(
            `Gateway returned ${statusCode}: ${body?.message || JSON.stringify(body)}`,
            statusCode,
            body
          );
        }

        // Retryable server errors
        lastError = new OpenClawError(
          `Gateway returned ${statusCode} on attempt ${attempt}`,
          statusCode,
          body
        );
      } catch (err) {
        if (err instanceof OpenClawError && err.statusCode >= 400 && err.statusCode < 500) {
          throw err;  // never retry 4xx
        }
        lastError = err;
      }

      if (attempt < this.maxRetries) {
        const delay = RETRY_DELAY_BASE_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }

    throw lastError;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Execute a named script on the remote host.
   *
   * POST /execute
   *
   * @param {string} scriptName   Script identifier registered on the gateway
   * @param {object} [params]     Key/value parameters passed to the script
   * @returns {Promise<{ jobId: string, status: string, output: string }>}
   */
  async executeScript(scriptName, params = {}) {
    if (!scriptName) throw new Error('scriptName is required');

    const body = await this._request({
      method: 'POST',
      url:    `${this.baseUrl}/execute`,
      body:   { script: scriptName, params },
    });

    return {
      jobId:  body.job_id  || body.jobId,
      status: body.status,
      output: body.output  || null,
    };
  }

  /**
   * Poll the status of an asynchronous job.
   *
   * GET /jobs/:id
   *
   * @param {string} jobId
   * @returns {Promise<{ jobId: string, status: string, output: string, exitCode: number, startedAt: string, finishedAt: string }>}
   */
  async getJobStatus(jobId) {
    if (!jobId) throw new Error('jobId is required');

    const body = await this._request({
      method: 'GET',
      url:    `${this.baseUrl}/jobs/${encodeURIComponent(jobId)}`,
    });

    return {
      jobId:      body.job_id      || body.jobId,
      status:     body.status,
      output:     body.output      || null,
      exitCode:   body.exit_code   ?? body.exitCode ?? null,
      startedAt:  body.started_at  || body.startedAt  || null,
      finishedAt: body.finished_at || body.finishedAt || null,
    };
  }

  /**
   * Read lines from a remote log file.
   *
   * POST /logs/read
   *
   * @param {string} path     Absolute path on the remote host
   * @param {number} [lines=100]
   * @returns {Promise<{ file: string, lines: string[], total_lines: number }>}
   */
  async getLogs(path, lines = 100) {
    if (!path) throw new Error('path is required');

    const body = await this._request({
      method: 'POST',
      url:    `${this.baseUrl}/logs/read`,
      body:   { path, lines },
    });

    return {
      file:        body.file,
      lines:       body.lines       || [],
      total_lines: body.total_lines || 0,
    };
  }

  /**
   * Retrieve system information from the remote host.
   *
   * GET /system/info
   *
   * @returns {Promise<{ hostname, os, arch, cpu_cores, ram_total_gb, uptime_seconds, load_avg }>}
   */
  async getSystemInfo() {
    const body = await this._request({
      method: 'GET',
      url:    `${this.baseUrl}/system/info`,
    });
    return body;
  }

  /**
   * Health-check / heartbeat ping.
   *
   * GET /health
   *
   * @returns {Promise<{ status: 'ok'|'degraded'|'down', version: string, uptime_seconds: number }>}
   */
  async heartbeat() {
    const body = await this._request({
      method: 'GET',
      url:    `${this.baseUrl}/health`,
    });
    return body;
  }

  // ── WebSocket Streaming ───────────────────────────────────────────────────

  /**
   * Stream real-time output for a running job via WebSocket.
   *
   * Connects to ws(s)://<gateway>/jobs/:id/stream
   *
   * @param {string}   jobId
   * @param {Function} onData       Called for each data chunk: (chunk: string) => void
   * @param {Function} onComplete   Called when job finishes:   ({ exitCode, status }) => void
   * @param {Function} [onError]    Called on error:            (err: Error) => void
   * @returns {{ close: Function }}  Object with a `close()` method to terminate the stream
   * @throws {Error} if the `ws` package is not installed
   */
  streamJob(jobId, onData, onComplete, onError) {
    if (!WebSocket) {
      throw new Error(
        'WebSocket streaming requires the "ws" package: npm install ws'
      );
    }
    if (!jobId)       throw new Error('jobId is required');
    if (!onData)      throw new Error('onData callback is required');
    if (!onComplete)  throw new Error('onComplete callback is required');

    const wsUrl = this.baseUrl
      .replace(/^https/, 'wss')
      .replace(/^http/,  'ws')
      + `/jobs/${encodeURIComponent(jobId)}/stream`;

    const ws = new WebSocket(wsUrl, {
      headers: this._defaultHeaders,
    });

    ws.on('open', () => {
      // Optionally send an auth frame if the gateway requires it
      ws.send(JSON.stringify({ type: 'auth', api_key: this.apiKey }));
    });

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { msg = { type: 'data', chunk: raw }; }

      switch (msg.type) {
        case 'data':
          onData(msg.chunk || '');
          break;
        case 'complete':
          onComplete({ exitCode: msg.exit_code, status: msg.status });
          ws.close();
          break;
        case 'error':
          if (onError) onError(new OpenClawError(msg.message || 'Stream error'));
          ws.close();
          break;
        default:
          // unknown message type — ignore
          break;
      }
    });

    ws.on('error', err => {
      if (onError) onError(err);
    });

    ws.on('close', (code, reason) => {
      if (code !== 1000 && onError) {
        onError(new Error(`WebSocket closed unexpectedly: ${code} ${reason}`));
      }
    });

    return {
      close: () => ws.close(),
    };
  }
}

// ─── Custom Error ─────────────────────────────────────────────────────────────

class OpenClawError extends Error {
  /**
   * @param {string} message
   * @param {number} [statusCode]
   * @param {object} [responseBody]
   */
  constructor(message, statusCode, responseBody) {
    super(message);
    this.name         = 'OpenClawError';
    this.statusCode   = statusCode   || null;
    this.responseBody = responseBody || null;
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { OpenClawClient, OpenClawError };

// ─── Usage Example (run directly with: node openclaw-client.js) ───────────────
if (require.main === module) {
  (async () => {
    const client = new OpenClawClient(
      process.env.OPENCLAW_URL    || 'http://localhost:8080',
      process.env.OPENCLAW_APIKEY || 'dev-secret'
    );

    // Heartbeat
    console.log('Heartbeat:', await client.heartbeat());

    // System info
    console.log('System Info:', await client.getSystemInfo());

    // Execute script
    const job = await client.executeScript('system_health_check', { verbose: true });
    console.log('Job started:', job);

    // Poll until done
    let result;
    do {
      await sleep(1000);
      result = await client.getJobStatus(job.jobId);
      console.log('Job status:', result.status);
    } while (!['completed', 'failed', 'timeout'].includes(result.status));

    console.log('Output:', result.output);
  })().catch(err => { console.error(err); process.exit(1); });
}
