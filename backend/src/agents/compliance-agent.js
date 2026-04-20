/**
 * RealSyncDynamics Agent-OS
 * Compliance-Agent Microservice
 *
 * Consumed by BullMQ queue (agent_type = 'compliance').
 * Implements EU AI Act (2024/1689) risk assessment and audit functions.
 *
 * Actions:
 *   assess_workflow_risk    — Score a workflow against EU AI Act risk tiers
 *   generate_compliance_report — Full compliance PDF-ready report
 *   check_data_flow         — Validate data transfers (GDPR Art. 44-49)
 *   check_human_oversight   — Verify human-in-the-loop requirements
 *   generate_audit_summary  — Aggregate audit log entries into summary
 *   scan_for_prohibited     — Detect prohibited AI practices (Art. 5)
 */

'use strict';

const express = require('express');
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
  defaultMeta: { service: 'compliance-agent' },
  transports: [new winston.transports.Console()],
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

// ─── Risk Tier Definitions (EU AI Act Annex III) ──────────────────────────────

const RISK_TIERS = {
  UNACCEPTABLE: {
    level: 4,
    label: 'Unacceptable',
    description: 'Prohibited under EU AI Act Art. 5',
    examples: ['social scoring', 'subliminal manipulation', 'real-time biometric surveillance'],
  },
  HIGH: {
    level: 3,
    label: 'High-Risk',
    description: 'Requires conformity assessment, logging, human oversight',
    examples: ['CV screening', 'credit scoring', 'critical infrastructure', 'biometric categorisation'],
  },
  LIMITED: {
    level: 2,
    label: 'Limited Risk',
    description: 'Transparency obligations (Art. 50)',
    examples: ['chatbots', 'content generation', 'deepfakes'],
  },
  MINIMAL: {
    level: 1,
    label: 'Minimal Risk',
    description: 'No mandatory requirements',
    examples: ['spam filters', 'AI in video games'],
  },
};

// ─── Prohibited Practice Keywords (Art. 5) ────────────────────────────────────

const PROHIBITED_KEYWORDS = [
  'social score', 'social scoring', 'citizen score',
  'subliminal', 'subconscious manipulation',
  'real-time biometric', 'facial recognition public',
  'emotion recognition workplace', 'emotion recognition education',
  'predictive policing individual',
  'vulnerability exploitation',
];

// ─── Router ───────────────────────────────────────────────────────────────────

const router = express.Router();

// ─── Middleware: Audit every compliance call ──────────────────────────────────

router.use((req, _res, next) => {
  logger.info('compliance-agent request', {
    action: req.body?.action,
    tenant_id: req.body?.tenant_id,
    ip: req.ip,
  });
  next();
});

// ─── POST /agent/compliance ───────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { action, payload = {}, tenant_id, user_id } = req.body;

  if (!action) {
    return res.status(400).json({ error: 'action is required' });
  }
  if (!tenant_id) {
    return res.status(400).json({ error: 'tenant_id is required' });
  }

  try {
    let result;

    switch (action) {

      // ── assess_workflow_risk ─────────────────────────────────────────────
      case 'assess_workflow_risk': {
        const { workflow_name, workflow_description, tools_used = [], data_types = [] } = payload;

        if (!workflow_description) {
          return res.status(400).json({ error: 'payload.workflow_description is required' });
        }

        const prompt = `
You are an EU AI Act compliance expert. Assess the risk tier of this AI workflow.

Workflow: "${workflow_name || 'Unnamed'}"
Description: "${workflow_description}"
Tools used: ${tools_used.join(', ') || 'unspecified'}
Data types processed: ${data_types.join(', ') || 'unspecified'}

EU AI Act Risk Tiers:
- UNACCEPTABLE (Art. 5): Prohibited practices
- HIGH (Annex III): Biometrics, critical infrastructure, employment, education, law enforcement, migration, justice
- LIMITED (Art. 50): Chatbots, synthetic content — transparency required
- MINIMAL: All other AI systems

Respond with JSON only:
{
  "tier": "UNACCEPTABLE|HIGH|LIMITED|MINIMAL",
  "score": 1-100,
  "rationale": "...",
  "required_measures": ["...", "..."],
  "prohibited_elements": ["..."],
  "recommendations": ["...", "..."]
}`.trim();

        const completion = await getOpenAI().chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        });

        const analysis = JSON.parse(completion.choices[0].message.content);
        const tierDetails = RISK_TIERS[analysis.tier] || RISK_TIERS.MINIMAL;

        result = {
          workflow_name: workflow_name || 'Unnamed',
          risk_assessment: {
            ...analysis,
            tier_details: tierDetails,
          },
          assessed_at: new Date().toISOString(),
          assessed_by: 'compliance-agent-v1',
          eu_ai_act_article: analysis.tier === 'UNACCEPTABLE' ? 'Art. 5' :
                             analysis.tier === 'HIGH' ? 'Art. 9-15, Annex III' :
                             analysis.tier === 'LIMITED' ? 'Art. 50' : 'No mandatory requirements',
          human_oversight_required: ['UNACCEPTABLE', 'HIGH'].includes(analysis.tier),
          conformity_assessment_required: analysis.tier === 'HIGH',
          ai_generated: true,
        };
        break;
      }

      // ── generate_compliance_report ───────────────────────────────────────
      case 'generate_compliance_report': {
        const { workflows = [], period_days = 30, include_recommendations = true } = payload;

        if (!workflows.length) {
          return res.status(400).json({ error: 'payload.workflows array is required' });
        }

        const prompt = `
You are an EU AI Act compliance officer. Generate a compliance report for ${period_days} days.

Workflows to assess:
${workflows.map((w, i) => `${i + 1}. ${w.name}: ${w.description}`).join('\n')}

Respond with JSON only:
{
  "executive_summary": "...",
  "overall_compliance_score": 0-100,
  "risk_distribution": { "UNACCEPTABLE": 0, "HIGH": 0, "LIMITED": 0, "MINIMAL": 0 },
  "workflow_assessments": [{ "name": "...", "tier": "...", "status": "compliant|non-compliant|needs-review", "issues": [] }],
  "critical_findings": ["..."],
  "recommended_actions": ["..."],
  "data_protection_status": "compliant|needs-review|non-compliant",
  "human_oversight_coverage": "percentage or description"
}`.trim();

        const completion = await getOpenAI().chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        });

        const report = JSON.parse(completion.choices[0].message.content);

        result = {
          report_id: `CR-${Date.now()}`,
          tenant_id,
          period_days,
          generated_at: new Date().toISOString(),
          generated_by: user_id || 'system',
          ...report,
          legal_basis: 'EU AI Act (2024/1689), GDPR (2016/679)',
          ai_generated: true,
        };
        break;
      }

      // ── check_data_flow ──────────────────────────────────────────────────
      case 'check_data_flow': {
        const { data_sources = [], data_destinations = [], personal_data = false, special_categories = false } = payload;

        const issues = [];
        const recommendations = [];

        if (personal_data && data_destinations.some(d =>
          !['EU', 'EEA', 'EU/EEA'].includes(d.region))) {
          issues.push('GDPR Art. 44: Personal data transfer outside EU/EEA requires adequacy decision or appropriate safeguards');
          recommendations.push('Implement Standard Contractual Clauses (SCCs) or verify adequacy decision for third-country transfers');
        }

        if (special_categories) {
          issues.push('GDPR Art. 9: Special category data requires explicit consent or other legal basis');
          recommendations.push('Document legal basis for processing special category data');
          recommendations.push('Conduct Data Protection Impact Assessment (DPIA) per GDPR Art. 35');
        }

        if (!payload.retention_policy) {
          issues.push('GDPR Art. 5(1)(e): No data retention policy specified');
          recommendations.push('Define and document data retention periods');
        }

        if (!payload.processing_basis) {
          issues.push('GDPR Art. 6: Legal basis for processing not specified');
          recommendations.push('Document legal basis: consent, contract, legal obligation, vital interests, public task, or legitimate interests');
        }

        result = {
          data_flow_id: `DF-${Date.now()}`,
          tenant_id,
          checked_at: new Date().toISOString(),
          personal_data,
          special_categories,
          cross_border_transfer: data_destinations.some(d => !['EU', 'EEA'].includes(d.region)),
          compliance_status: issues.length === 0 ? 'compliant' : issues.length <= 2 ? 'needs-review' : 'non-compliant',
          issues,
          recommendations,
          gdpr_articles_applicable: [
            'Art. 5 (Principles)',
            'Art. 6 (Lawfulness)',
            ...(special_categories ? ['Art. 9 (Special categories)'] : []),
            ...(data_destinations.some(d => !['EU', 'EEA'].includes(d.region)) ? ['Art. 44-49 (Transfers)'] : []),
          ],
        };
        break;
      }

      // ── check_human_oversight ────────────────────────────────────────────
      case 'check_human_oversight': {
        const { workflow_config = {}, risk_tier = 'MINIMAL' } = payload;

        const requirements = [];
        const gaps = [];

        const highRisk = ['HIGH', 'UNACCEPTABLE'].includes(risk_tier);

        if (highRisk) {
          if (!workflow_config.human_approval_required) {
            gaps.push('EU AI Act Art. 14: High-risk AI systems require human oversight — no approval gate configured');
            requirements.push('Add human approval step before consequential actions');
          }
          if (!workflow_config.override_capability) {
            gaps.push('EU AI Act Art. 14(4): Users must be able to override or stop AI system — not implemented');
            requirements.push('Implement manual override mechanism');
          }
          if (!workflow_config.monitoring_enabled) {
            gaps.push('EU AI Act Art. 9: Risk management requires continuous monitoring — not enabled');
            requirements.push('Enable real-time monitoring and anomaly detection');
          }
          if (!workflow_config.audit_logging) {
            gaps.push('EU AI Act Art. 12: High-risk systems must maintain logs automatically — not configured');
            requirements.push('Enable comprehensive audit logging with retention >= 6 months');
          }
        }

        result = {
          workflow_id: workflow_config.id || 'unknown',
          tenant_id,
          risk_tier,
          checked_at: new Date().toISOString(),
          oversight_compliant: gaps.length === 0,
          gaps,
          requirements,
          human_approval_gate: !!workflow_config.human_approval_required,
          override_capability: !!workflow_config.override_capability,
          monitoring_enabled: !!workflow_config.monitoring_enabled,
          audit_logging: !!workflow_config.audit_logging,
          eu_ai_act_articles: ['Art. 9 (Risk management)', 'Art. 12 (Record-keeping)', 'Art. 14 (Human oversight)'],
        };
        break;
      }

      // ── generate_audit_summary ───────────────────────────────────────────
      case 'generate_audit_summary': {
        const { audit_entries = [], period_start, period_end } = payload;

        if (!audit_entries.length) {
          return res.status(400).json({ error: 'payload.audit_entries array is required' });
        }

        const actionCounts = audit_entries.reduce((acc, e) => {
          acc[e.action] = (acc[e.action] || 0) + 1;
          return acc;
        }, {});

        const uniqueUsers = [...new Set(audit_entries.map(e => e.user_id).filter(Boolean))];
        const errorEntries = audit_entries.filter(e => e.status === 'error' || e.status === 'failed');
        const approvalEntries = audit_entries.filter(e => e.action?.includes('approval') || e.action?.includes('override'));

        result = {
          summary_id: `AS-${Date.now()}`,
          tenant_id,
          period: { start: period_start, end: period_end },
          generated_at: new Date().toISOString(),
          total_entries: audit_entries.length,
          unique_users: uniqueUsers.length,
          action_breakdown: actionCounts,
          error_count: errorEntries.length,
          error_rate_pct: ((errorEntries.length / audit_entries.length) * 100).toFixed(1),
          human_interventions: approvalEntries.length,
          top_actions: Object.entries(actionCounts)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([action, count]) => ({ action, count })),
          compliance_indicators: {
            audit_coverage: '100%',
            human_oversight_events: approvalEntries.length,
            anomalies_detected: errorEntries.length,
          },
        };
        break;
      }

      // ── scan_for_prohibited ──────────────────────────────────────────────
      case 'scan_for_prohibited': {
        const { text = '', workflow_config = {} } = payload;

        if (!text && !Object.keys(workflow_config).length) {
          return res.status(400).json({ error: 'payload.text or payload.workflow_config is required' });
        }

        const scanText = (text + JSON.stringify(workflow_config)).toLowerCase();
        const foundKeywords = PROHIBITED_KEYWORDS.filter(kw => scanText.includes(kw.toLowerCase()));

        let aiAnalysis = null;
        if (text.length > 50) {
          const prompt = `
Scan this text for prohibited AI practices under EU AI Act Art. 5.
Prohibited: social scoring, subliminal manipulation, real-time biometric surveillance in public, emotion recognition workplace/education, predictive policing individuals, exploitation of vulnerabilities.

Text: "${text.substring(0, 2000)}"

Respond with JSON only:
{
  "prohibited_elements_found": ["..."],
  "risk_level": "none|low|medium|high|critical",
  "explanation": "...",
  "relevant_article": "..."
}`.trim();

          const completion = await getOpenAI().chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: 'json_object' },
            temperature: 0.1,
          });
          aiAnalysis = JSON.parse(completion.choices[0].message.content);
        }

        result = {
          scan_id: `SC-${Date.now()}`,
          tenant_id,
          scanned_at: new Date().toISOString(),
          keyword_matches: foundKeywords,
          prohibited_detected: foundKeywords.length > 0 || (aiAnalysis?.prohibited_elements_found?.length > 0),
          risk_level: aiAnalysis?.risk_level || (foundKeywords.length > 0 ? 'high' : 'none'),
          ai_analysis: aiAnalysis,
          eu_ai_act_article: 'Art. 5 — Prohibited AI Practices',
          action_required: foundKeywords.length > 0 ? 'BLOCK' : 'ALLOW',
        };
        break;
      }

      default:
        return res.status(400).json({
          error: `Unknown action: ${action}`,
          supported_actions: [
            'assess_workflow_risk',
            'generate_compliance_report',
            'check_data_flow',
            'check_human_oversight',
            'generate_audit_summary',
            'scan_for_prohibited',
          ],
        });
    }

    logger.info('compliance-agent success', { action, tenant_id });

    return res.json({
      success: true,
      action,
      tenant_id,
      result,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    logger.error('compliance-agent error', { action, tenant_id, error: err.message, stack: err.stack });
    return res.status(500).json({
      error: 'Compliance agent execution failed',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

module.exports = router;
