/**
 * RealSyncDynamics Agent-OS
 * Marketing-Agent Microservice
 *
 * Consumed by BullMQ queue (agent_type = 'marketing').
 * Handles social-media content generation and publishing.
 *
 * EU AI Act Art. 50: Every piece of generated content is marked
 * with { ai_generated: true } in the response payload.
 */

'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { OpenAI } = require('openai');
const winston = require('winston');

// ─── Logger ──────────────────────────────────────────────────────────────────

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'marketing-agent' },
  transports: [
    new winston.transports.Console(),
  ],
});

// ─── OpenAI Client ────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Router ───────────────────────────────────────────────────────────────────

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Exponential backoff retry for async functions.
 * @param {Function} fn      - Async function to retry
 * @param {number}   retries - Max retry attempts (default 3)
 * @param {number}   delay   - Initial delay in ms (default 500)
 */
async function withRetry(fn, retries = 3, delay = 500) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const wait = delay * Math.pow(2, attempt);
        logger.warn({ msg: 'Retry attempt', attempt: attempt + 1, wait_ms: wait, error: err.message });
        await new Promise((res) => setTimeout(res, wait));
      }
    }
  }
  throw lastError;
}

/**
 * Write an AgentRun log entry.
 * In production replace this stub with a DB insert or message-bus publish.
 *
 * SQL schema (reference):
 * CREATE TABLE agent_run_logs (
 *   id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   task_id       UUID,
 *   workflow_id   UUID,
 *   tenant_id     UUID,
 *   agent_type    TEXT NOT NULL,
 *   action        TEXT NOT NULL,
 *   model_used    TEXT,
 *   input_json    JSONB,
 *   output_json   JSONB,
 *   tokens_used   INTEGER,
 *   duration_ms   INTEGER,
 *   created_at    TIMESTAMPTZ DEFAULT NOW()
 * );
 */
function writeAgentRunLog(entry) {
  logger.info({ msg: 'agent_run_log', ...entry });
  // TODO: await pool.query('INSERT INTO agent_run_logs (...) VALUES (...)', [...])
}

/**
 * RFC 9457 Problem Detail error response.
 */
function problemDetail(res, status, title, detail, extra = {}) {
  return res.status(status).json({
    type: `https://realsync.ai/problems/${title.toLowerCase().replace(/\s+/g, '-')}`,
    title,
    status,
    detail,
    ...extra,
  });
}

// ─── Action: generate_caption ─────────────────────────────────────────────────

async function generateCaption({ task_id, workflow_id, tenant_id, params }) {
  const {
    topic,
    platform = 'instagram',
    tone = 'professional',
    max_chars = 300,
    hashtags_count = 5,
  } = params;

  const systemPrompt =
    `Du bist ein Social-Media-Experte. Erstelle eine ansprechende Caption für ${platform}. ` +
    `Ton: ${tone}. Maximale Länge: ${max_chars} Zeichen. ` +
    `Antworte ausschließlich als gültiges JSON-Objekt mit den Feldern: ` +
    `caption (string), hashtags (array of strings ohne #-Präfix).`;

  const userPrompt = `Erstelle eine ${platform}-Caption über folgendes Thema: "${topic}". ` +
    `Inkludiere genau ${hashtags_count} relevante Hashtags.`;

  const start = Date.now();
  const completion = await withRetry(() =>
    openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 600,
    })
  );

  const raw = JSON.parse(completion.choices[0].message.content);
  const caption = String(raw.caption || '').slice(0, max_chars);
  const hashtags = (raw.hashtags || []).slice(0, hashtags_count).map((h) => `#${h.replace(/^#/, '')}`);

  const result = {
    caption,
    hashtags,
    char_count: caption.length,
    platform,
    ai_generated: true, // EU AI Act Art. 50
  };

  writeAgentRunLog({
    task_id, workflow_id, tenant_id,
    agent_type: 'marketing',
    action: 'generate_caption',
    model_used: 'gpt-4o',
    input_json: params,
    output_json: result,
    tokens_used: completion.usage?.total_tokens,
    duration_ms: Date.now() - start,
  });

  return result;
}

// ─── Action: generate_content_plan ───────────────────────────────────────────

async function generateContentPlan({ task_id, workflow_id, tenant_id, params }) {
  const {
    company_name,
    industry,
    week_start_date,
    posts_per_week = 5,
    platforms = ['instagram', 'linkedin'],
  } = params;

  const systemPrompt =
    'Du bist ein erfahrener Social-Media-Stratege. Erstelle einen wöchentlichen Content-Plan als JSON. ' +
    'Das Objekt muss die Felder week_start (ISO-Datum) und posts (Array) enthalten. ' +
    'Jeder Post hat: date (ISO-Datum), platform, topic, caption_draft, hashtags (Array).';

  const userPrompt =
    `Unternehmen: "${company_name}", Branche: "${industry}". ` +
    `Woche ab: ${week_start_date}. Anzahl Posts: ${posts_per_week}. ` +
    `Plattformen: ${platforms.join(', ')}.`;

  const start = Date.now();
  const completion = await withRetry(() =>
    openai.chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2000,
    })
  );

  const raw = JSON.parse(completion.choices[0].message.content);
  const result = {
    week_start: raw.week_start || week_start_date,
    posts: (raw.posts || []).map((p) => ({
      date: p.date,
      platform: p.platform,
      topic: p.topic,
      caption_draft: p.caption_draft,
      hashtags: p.hashtags || [],
    })),
    ai_generated: true, // EU AI Act Art. 50
  };

  writeAgentRunLog({
    task_id, workflow_id, tenant_id,
    agent_type: 'marketing',
    action: 'generate_content_plan',
    model_used: 'gpt-4o',
    input_json: params,
    output_json: result,
    tokens_used: completion.usage?.total_tokens,
    duration_ms: Date.now() - start,
  });

  return result;
}

// ─── Action: post_to_linkedin ─────────────────────────────────────────────────

async function postToLinkedin({ task_id, workflow_id, tenant_id, params }) {
  const {
    access_token,
    author_urn,
    text,
    visibility = 'PUBLIC',
  } = params;

  const body = {
    author: author_urn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE',
      },
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': visibility,
    },
  };

  const start = Date.now();
  const response = await withRetry(() =>
    axios.post('https://api.linkedin.com/v2/ugcPosts', body, {
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
    })
  );

  const post_id = response.headers['x-restli-id'] || response.data?.id || '';
  const result = {
    post_id,
    url: `https://www.linkedin.com/feed/update/${post_id}`,
    status: 'published',
  };

  writeAgentRunLog({
    task_id, workflow_id, tenant_id,
    agent_type: 'marketing',
    action: 'post_to_linkedin',
    model_used: null,
    input_json: { author_urn, visibility, text_length: text?.length },
    output_json: result,
    tokens_used: null,
    duration_ms: Date.now() - start,
  });

  return result;
}

// ─── Action: post_to_twitter ──────────────────────────────────────────────────

/**
 * Build an OAuth 1.0a Authorization header for the Twitter v2 API.
 * Implements HMAC-SHA1 signature as per RFC 5849.
 */
function buildOAuth1Header({ method, url, consumerKey, consumerSecret, oauthToken, oauthSecret }) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: oauthToken,
    oauth_version: '1.0',
  };

  // Percent-encode per RFC 5849 §3.6
  const pct = (s) => encodeURIComponent(String(s)).replace(/!/g, '%21').replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\*/g, '%2A');

  // Build base string
  const sortedParams = Object.keys(oauthParams)
    .sort()
    .map((k) => `${pct(k)}=${pct(oauthParams[k])}`)
    .join('&');
  const baseString = [method.toUpperCase(), pct(url), pct(sortedParams)].join('&');

  // Build signing key
  const signingKey = `${pct(consumerSecret)}&${pct(oauthSecret)}`;

  // HMAC-SHA1
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
  oauthParams.oauth_signature = signature;

  const headerValue =
    'OAuth ' +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${pct(k)}="${pct(oauthParams[k])}"`)
      .join(', ');

  return headerValue;
}

async function postToTwitter({ task_id, workflow_id, tenant_id, params }) {
  const {
    bearer_token,
    oauth_token,
    oauth_secret,
    consumer_key,
    consumer_secret,
    text,
  } = params;

  const url = 'https://api.twitter.com/2/tweets';
  const authHeader = buildOAuth1Header({
    method: 'POST',
    url,
    consumerKey: consumer_key,
    consumerSecret: consumer_secret,
    oauthToken: oauth_token,
    oauthSecret: oauth_secret,
  });

  const start = Date.now();
  const response = await withRetry(() =>
    axios.post(url, { text }, {
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
    })
  );

  const tweet_id = response.data?.data?.id;
  const result = {
    tweet_id,
    url: `https://twitter.com/i/web/status/${tweet_id}`,
    text,
  };

  writeAgentRunLog({
    task_id, workflow_id, tenant_id,
    agent_type: 'marketing',
    action: 'post_to_twitter',
    model_used: null,
    input_json: { text_length: text?.length },
    output_json: result,
    tokens_used: null,
    duration_ms: Date.now() - start,
  });

  return result;
}

// ─── Action: post_to_facebook ─────────────────────────────────────────────────

async function postToFacebook({ task_id, workflow_id, tenant_id, params }) {
  const { page_access_token, page_id, message, link } = params;

  const body = { message, access_token: page_access_token };
  if (link) body.link = link;

  const start = Date.now();
  const response = await withRetry(() =>
    axios.post(`https://graph.facebook.com/v19.0/${page_id}/feed`, body)
  );

  const post_id = response.data?.id;
  const result = {
    post_id,
    url: `https://www.facebook.com/${post_id?.replace('_', '/posts/')}`,
  };

  writeAgentRunLog({
    task_id, workflow_id, tenant_id,
    agent_type: 'marketing',
    action: 'post_to_facebook',
    model_used: null,
    input_json: { page_id, message_length: message?.length, has_link: !!link },
    output_json: result,
    tokens_used: null,
    duration_ms: Date.now() - start,
  });

  return result;
}

// ─── Action: schedule_posts ───────────────────────────────────────────────────

/**
 * SQL schema for scheduled_posts table:
 *
 * CREATE TABLE scheduled_posts (
 *   id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   tenant_id      UUID NOT NULL,
 *   workflow_id    UUID,
 *   platform       TEXT NOT NULL,
 *   text           TEXT NOT NULL,
 *   post_params    JSONB,
 *   scheduled_at   TIMESTAMPTZ NOT NULL,
 *   status         TEXT NOT NULL DEFAULT 'pending',  -- pending | published | failed
 *   created_at     TIMESTAMPTZ DEFAULT NOW(),
 *   published_at   TIMESTAMPTZ
 * );
 * CREATE INDEX idx_scheduled_posts_scheduled_at ON scheduled_posts(scheduled_at) WHERE status = 'pending';
 */
async function schedulePosts({ task_id, workflow_id, tenant_id, params }) {
  const { posts = [] } = params;

  const enriched = posts.map((p) => ({
    id: crypto.randomUUID(),
    tenant_id,
    workflow_id,
    platform: p.platform,
    text: p.text,
    post_params: p.params || {},
    scheduled_at: p.scheduled_at,
    status: 'pending',
    created_at: new Date().toISOString(),
  }));

  // TODO: await pool.query('INSERT INTO scheduled_posts (...) SELECT * FROM jsonb_populate_recordset(...)', [JSON.stringify(enriched)])
  logger.info({ msg: 'schedule_posts', count: enriched.length, tenant_id });

  const result = {
    scheduled_count: enriched.length,
    posts: enriched,
  };

  writeAgentRunLog({
    task_id, workflow_id, tenant_id,
    agent_type: 'marketing',
    action: 'schedule_posts',
    model_used: null,
    input_json: { posts_count: posts.length },
    output_json: result,
    tokens_used: null,
    duration_ms: 0,
  });

  return result;
}

// ─── Action: get_analytics ────────────────────────────────────────────────────

// NOTE: Replace with real platform API calls:
//   - LinkedIn: GET https://api.linkedin.com/v2/organizationalEntityShareStatistics
//   - Twitter: GET https://api.twitter.com/2/tweets?metrics=public_metrics
//   - Facebook: GET https://graph.facebook.com/v19.0/{page_id}/insights
async function getAnalytics({ task_id, workflow_id, tenant_id, params }) {
  const { platform = 'instagram', since_date } = params;

  const mockResult = {
    platform,
    since_date,
    total_posts: 24,
    avg_engagement: 4.7,           // percent
    top_post: {
      text: 'Sample top-performing post text…',
      likes: 312,
      shares: 47,
      comments: 19,
    },
    note: 'Mock data — replace with real API calls',
  };

  writeAgentRunLog({
    task_id, workflow_id, tenant_id,
    agent_type: 'marketing',
    action: 'get_analytics',
    model_used: null,
    input_json: params,
    output_json: mockResult,
    tokens_used: null,
    duration_ms: 1,
  });

  return mockResult;
}

// ─── Dispatch Map ─────────────────────────────────────────────────────────────

const ACTION_MAP = {
  generate_caption:        generateCaption,
  generate_content_plan:   generateContentPlan,
  post_to_linkedin:        postToLinkedin,
  post_to_twitter:         postToTwitter,
  post_to_facebook:        postToFacebook,
  schedule_posts:          schedulePosts,
  get_analytics:           getAnalytics,
};

// ─── POST /agent/marketing/execute ───────────────────────────────────────────

router.post('/execute', async (req, res) => {
  const { task_id, workflow_id, tenant_id, action, params } = req.body;

  if (!action) {
    return problemDetail(res, 400, 'Missing Action', '`action` field is required.');
  }

  const handler = ACTION_MAP[action];
  if (!handler) {
    return problemDetail(res, 400, 'Unknown Action', `Action "${action}" is not supported.`, {
      supported_actions: Object.keys(ACTION_MAP),
    });
  }

  logger.info({ msg: 'execute', action, task_id, workflow_id, tenant_id });

  try {
    const output = await handler({ task_id, workflow_id, tenant_id, params: params || {} });
    return res.status(200).json({ ok: true, action, task_id, workflow_id, output });
  } catch (err) {
    logger.error({ msg: 'execute_error', action, task_id, error: err.message, stack: err.stack });

    // Axios API errors
    if (err.response) {
      return problemDetail(res, 502, 'Upstream API Error',
        `External API returned ${err.response.status}: ${JSON.stringify(err.response.data)}`,
        { action, upstream_status: err.response.status });
    }

    return problemDetail(res, 500, 'Internal Agent Error', err.message, { action, task_id });
  }
});

// ─── GET /agent/marketing/health ─────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    agent: 'marketing-agent',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    supported_actions: Object.keys(ACTION_MAP),
    openai_configured: !!process.env.OPENAI_API_KEY,
  });
});

// ─── Mount & Export ───────────────────────────────────────────────────────────

/**
 * Usage in your Express app:
 *   const marketingAgent = require('./agents/marketing-agent');
 *   app.use('/agent/marketing', marketingAgent);
 */
module.exports = router;
