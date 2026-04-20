/**
 * RealSyncDynamics Agent-OS
 * Research-Agent Microservice
 *
 * Provides market research capabilities: web search, market summarization,
 * survey generation, and competitor analysis.
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
  defaultMeta: { service: 'research-agent' },
  transports: [
    new winston.transports.Console(),
  ],
});

// ─── OpenAI Client ────────────────────────────────────────────────────────────

// Lazy init: avoids crash when OPENAI_API_KEY is absent in test/CI environments
let _openai = null;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'sk-placeholder' });
  }
  return _openai;
}

// ─── Router ───────────────────────────────────────────────────────────────────

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Exponential backoff retry for async functions.
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
        logger.warn({ msg: 'retry', attempt: attempt + 1, wait_ms: wait, error: err.message });
        await new Promise((res) => setTimeout(res, wait));
      }
    }
  }
  throw lastError;
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

/**
 * AgentRun log stub.
 *
 * SQL schema:
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

// ─── Action: web_search ───────────────────────────────────────────────────────

/**
 * Performs a web search using DuckDuckGo's Instant Answer API.
 *
 * Note: DuckDuckGo's public API is best suited for instant answers.
 * For comprehensive search results, switch to Serper.dev:
 *   POST https://google.serper.dev/search
 *   Headers: X-API-KEY: process.env.SERPER_API_KEY
 *   Body: { q: query, num: num_results }
 */
async function webSearch({ task_id, workflow_id, tenant_id, params }) {
  const { query, num_results = 5 } = params;

  const start = Date.now();

  // Primary: DuckDuckGo Instant Answer API
  let results = [];
  let used_engine = 'duckduckgo';

  try {
    const ddgResponse = await withRetry(() =>
      axios.get('https://api.duckduckgo.com/', {
        params: {
          q: query,
          format: 'json',
          no_html: '1',
          skip_disambig: '1',
        },
        timeout: 8000,
      })
    );

    const data = ddgResponse.data;

    // DuckDuckGo returns RelatedTopics for most queries
    const topics = data.RelatedTopics || [];
    results = topics
      .filter((t) => t.Text && t.FirstURL)
      .slice(0, num_results)
      .map((t) => ({
        title: t.Text.split(' - ')[0] || t.Text.slice(0, 80),
        snippet: t.Text,
        url: t.FirstURL,
      }));

    // If instant answer exists, prepend it
    if (data.AbstractText) {
      results.unshift({
        title: data.Heading || 'Instant Answer',
        snippet: data.AbstractText,
        url: data.AbstractURL || data.AbstractSource,
      });
      results = results.slice(0, num_results);
    }
  } catch (err) {
    logger.warn({ msg: 'duckduckgo_fallback', error: err.message });
    // Fallback: Serper.dev (requires SERPER_API_KEY env var)
    if (process.env.SERPER_API_KEY) {
      used_engine = 'serper';
      const serperResponse = await withRetry(() =>
        axios.post(
          'https://google.serper.dev/search',
          { q: query, num: num_results },
          {
            headers: {
              'X-API-KEY': process.env.SERPER_API_KEY,
              'Content-Type': 'application/json',
            },
            timeout: 8000,
          }
        )
      );
      results = (serperResponse.data.organic || []).slice(0, num_results).map((r) => ({
        title: r.title,
        snippet: r.snippet,
        url: r.link,
      }));
    }
  }

  const output = {
    query,
    results,
    search_date: new Date().toISOString(),
    engine: used_engine,
    duration_ms: Date.now() - start,
  };

  writeAgentRunLog({
    task_id, workflow_id, tenant_id,
    agent_type: 'research',
    action: 'web_search',
    model_used: null,
    input_json: params,
    output_json: { query, result_count: results.length, engine: used_engine },
    tokens_used: null,
    duration_ms: output.duration_ms,
  });

  return output;
}

// ─── Action: summarize_market ─────────────────────────────────────────────────

async function summarizeMarket({ task_id, workflow_id, tenant_id, params }) {
  const { topic, context = '', results = [] } = params;

  const systemPrompt =
    'Du bist ein Marktanalyse-Experte. Fasse die folgenden Suchergebnisse zu einer präzisen ' +
    'Marktanalyse zusammen. Antworte als JSON-Objekt mit: ' +
    'summary (string — kurze Zusammenfassung), ' +
    'key_findings (array of strings), ' +
    'market_size_estimate (string — Schätzung der Marktgröße, falls ableitbar, sonst null), ' +
    'trends (array of strings), ' +
    'sources (array of strings — URLs aus den Ergebnissen).';

  const userPrompt =
    `Thema: ${topic}. ` +
    (context ? `Kontext: ${context}. ` : '') +
    `Suchergebnisse: ${JSON.stringify(results)}.`;

  const start = Date.now();
  const completion = await withRetry(() =>
    getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1200,
    })
  );

  const raw = JSON.parse(completion.choices[0].message.content);
  const output = {
    summary: raw.summary || '',
    key_findings: raw.key_findings || [],
    market_size_estimate: raw.market_size_estimate || null,
    trends: raw.trends || [],
    sources: raw.sources || results.map((r) => r.url).filter(Boolean),
    ai_generated: true, // EU AI Act Art. 50
    tokens_used: completion.usage?.total_tokens,
    duration_ms: Date.now() - start,
  };

  writeAgentRunLog({
    task_id, workflow_id, tenant_id,
    agent_type: 'research',
    action: 'summarize_market',
    model_used: 'gpt-4o',
    input_json: { topic, context, results_count: results.length },
    output_json: output,
    tokens_used: output.tokens_used,
    duration_ms: output.duration_ms,
  });

  return output;
}

// ─── Action: generate_survey ──────────────────────────────────────────────────

async function generateSurvey({ task_id, workflow_id, tenant_id, params }) {
  const {
    target_group = 'kmu',
    topic,
    num_questions = 10,
  } = params;

  const targetGroupLabels = {
    kmu: 'kleine und mittlere Unternehmen (KMU)',
    school: 'Schulen und Bildungseinrichtungen',
    authority: 'öffentliche Behörden und Verwaltungen',
  };
  const label = targetGroupLabels[target_group] || target_group;

  const systemPrompt =
    'Du bist ein erfahrener UX-Researcher und Umfrage-Designer. ' +
    'Erstelle ein professionelles Umfrage-Template als JSON-Objekt mit: ' +
    'title (string), description (string), ' +
    'questions (array). Jede Frage hat: id (string), text (string), ' +
    'type ("scale" | "choice" | "text"), ' +
    'options (array of strings — nur bei "choice" und "scale", bei "text" leer).';

  const userPrompt =
    `Zielgruppe: ${label}. ` +
    `Thema: ${topic}. ` +
    `Anzahl Fragen: ${num_questions}. ` +
    'Mische die Fragetypen sinnvoll. Für "scale"-Fragen: options = ["1 - Gar nicht", "2", "3", "4", "5 - Sehr stark"].';

  const start = Date.now();
  const completion = await withRetry(() =>
    getOpenAI().chat.completions.create({
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
  const output = {
    title: raw.title || `Umfrage: ${topic}`,
    description: raw.description || '',
    target_group,
    questions: (raw.questions || []).map((q, idx) => ({
      id: q.id || `q_${idx + 1}`,
      text: q.text || '',
      type: q.type || 'text',
      options: q.options || [],
    })),
    ai_generated: true, // EU AI Act Art. 50
    tokens_used: completion.usage?.total_tokens,
    duration_ms: Date.now() - start,
  };

  writeAgentRunLog({
    task_id, workflow_id, tenant_id,
    agent_type: 'research',
    action: 'generate_survey',
    model_used: 'gpt-4o',
    input_json: params,
    output_json: { title: output.title, question_count: output.questions.length },
    tokens_used: output.tokens_used,
    duration_ms: output.duration_ms,
  });

  return output;
}

// ─── Action: analyze_competitor ───────────────────────────────────────────────

async function analyzeCompetitor({ task_id, workflow_id, tenant_id, params }) {
  const {
    competitor_name,
    focus_areas = ['pricing', 'features', 'positioning'],
  } = params;

  // Step 1: Web search for fresh data
  const searchQuery = `${competitor_name} ${focus_areas.join(' ')} 2024 2025`;
  const searchStart = Date.now();

  let searchResults = [];
  try {
    const ddgResponse = await withRetry(() =>
      axios.get('https://api.duckduckgo.com/', {
        params: {
          q: searchQuery,
          format: 'json',
          no_html: '1',
          skip_disambig: '1',
        },
        timeout: 8000,
      })
    );
    const data = ddgResponse.data;
    const topics = data.RelatedTopics || [];
    searchResults = topics
      .filter((t) => t.Text && t.FirstURL)
      .slice(0, 8)
      .map((t) => ({ title: t.Text.slice(0, 80), snippet: t.Text, url: t.FirstURL }));

    if (data.AbstractText) {
      searchResults.unshift({
        title: data.Heading || competitor_name,
        snippet: data.AbstractText,
        url: data.AbstractURL || '',
      });
    }
  } catch (err) {
    logger.warn({ msg: 'competitor_search_failed', error: err.message });
    // Proceed with empty results — LLM will use training data
  }

  // Step 2: LLM analysis
  const systemPrompt =
    'Du bist ein Strategie-Berater. Analysiere den angegebenen Wettbewerber anhand der bereitgestellten ' +
    'Suchergebnisse und deines Hintergrundwissens. ' +
    'Antworte als JSON-Objekt mit: ' +
    'name (string), ' +
    'strengths (array of strings), ' +
    'weaknesses (array of strings), ' +
    'pricing_estimate (string — Preisschätzung, z.B. "€49–€199/Monat" oder "Freemium"), ' +
    'differentiation (array of strings — Alleinstellungsmerkmale gegenüber dem Markt).';

  const userPrompt =
    `Wettbewerber: ${competitor_name}. ` +
    `Analysefokus: ${focus_areas.join(', ')}. ` +
    `Suchergebnisse: ${JSON.stringify(searchResults)}.`;

  const llmStart = Date.now();
  const completion = await withRetry(() =>
    getOpenAI().chat.completions.create({
      model: 'gpt-4o',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 900,
    })
  );

  const raw = JSON.parse(completion.choices[0].message.content);
  const output = {
    name: raw.name || competitor_name,
    strengths: raw.strengths || [],
    weaknesses: raw.weaknesses || [],
    pricing_estimate: raw.pricing_estimate || null,
    differentiation: raw.differentiation || [],
    sources: searchResults.map((r) => r.url).filter(Boolean),
    search_date: new Date().toISOString(),
    ai_generated: true, // EU AI Act Art. 50
    tokens_used: completion.usage?.total_tokens,
    duration_ms: (Date.now() - searchStart),
  };

  writeAgentRunLog({
    task_id, workflow_id, tenant_id,
    agent_type: 'research',
    action: 'analyze_competitor',
    model_used: 'gpt-4o',
    input_json: params,
    output_json: { name: output.name, strengths_count: output.strengths.length },
    tokens_used: output.tokens_used,
    duration_ms: output.duration_ms,
  });

  return output;
}

// ─── Dispatch Map ─────────────────────────────────────────────────────────────

const ACTION_MAP = {
  web_search:          webSearch,
  summarize_market:    summarizeMarket,
  generate_survey:     generateSurvey,
  analyze_competitor:  analyzeCompetitor,
};

// ─── POST /agent/research/execute ─────────────────────────────────────────────

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

    if (err.response) {
      return problemDetail(res, 502, 'Upstream API Error',
        `External API returned ${err.response.status}: ${JSON.stringify(err.response.data)}`,
        { action, upstream_status: err.response.status });
    }

    return problemDetail(res, 500, 'Internal Agent Error', err.message, { action, task_id });
  }
});

// ─── GET /agent/research/health ───────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    agent: 'research-agent',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    supported_actions: Object.keys(ACTION_MAP),
    openai_configured: !!process.env.OPENAI_API_KEY,
    serper_configured: !!process.env.SERPER_API_KEY,
  });
});

// ─── Mount & Export ───────────────────────────────────────────────────────────

/**
 * Usage in your Express app:
 *   const researchAgent = require('./agents/research-agent');
 *   app.use('/agent/research', researchAgent);
 */
module.exports = router;
