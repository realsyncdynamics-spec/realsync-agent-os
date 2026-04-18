'use strict';

/**
 * RealSyncDynamics — Plan-Limits Middleware
 * Prüft ob ein Tenant sein Plan-Limit erreicht hat bevor eine Aktion ausgeführt wird.
 *
 * Verwendung in Routes:
 *   const { checkWorkflowLimit, checkAgentTypeAllowed, checkMonthlyRunLimit } = require('../middleware/plan-limits');
 *
 *   router.post('/workflows', checkWorkflowLimit, createWorkflowHandler);
 *   router.post('/workflows/:id/execute', checkMonthlyRunLimit, checkAgentTypeAllowed('devops'), executeHandler);
 */

const db = require('../db');
const { PLANS, isLimitExceeded, getUpgradeUrl } = require('../config/plans');

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * RFC 9457 konforme 402-Antwort senden.
 */
function sendPaymentRequired(res, title, detail, upgradeUrl, extra = {}) {
  return res.status(402).json({
    type: 'https://realsyncdynamics.com/errors/plan-limit-exceeded',
    title,
    status: 402,
    detail,
    instance: res.req.originalUrl,
    upgrade_url: upgradeUrl,
    ...extra,
  });
}

/**
 * Tenant mit Plan-Limits aus DB laden.
 * Cached auf req.tenantData um mehrfache DB-Abfragen in einem Request zu vermeiden.
 */
async function loadTenantData(req) {
  if (req.tenantData) return req.tenantData;

  const result = await db.query(
    'SELECT id, name, plan, settings FROM tenants WHERE id = $1',
    [req.tenant_id]
  );
  const tenant = result.rows[0];
  if (!tenant) throw new Error(`Tenant nicht gefunden: ${req.tenant_id}`);

  req.tenantData = tenant;
  return tenant;
}

// ---------------------------------------------------------------------------
// Middleware 1: checkWorkflowLimit
// Prüft ob der Tenant sein max_workflows-Limit erreicht hat.
// ---------------------------------------------------------------------------

/**
 * @middleware checkWorkflowLimit
 * Blockiert POST /workflows wenn das Workflow-Limit überschritten ist.
 */
async function checkWorkflowLimit(req, res, next) {
  try {
    const tenant = await loadTenantData(req);
    const planConfig = PLANS[tenant.plan] || PLANS.free;
    const limit = planConfig.limits.max_workflows;

    // Unlimited-Plan: direkt weiter
    if (limit === -1) return next();

    // Aktuelle Workflow-Anzahl zählen
    const result = await db.query(
      "SELECT COUNT(*) AS count FROM workflows WHERE tenant_id = $1 AND status != 'deleted'",
      [req.tenant_id]
    );
    const currentCount = parseInt(result.rows[0].count, 10);

    if (isLimitExceeded(limit, currentCount)) {
      const upgradeUrl = getUpgradeUrl();
      return sendPaymentRequired(
        res,
        'Workflow-Limit erreicht',
        `Dein ${planConfig.name}-Plan erlaubt maximal ${limit} Workflows. Du hast bereits ${currentCount} Workflows erstellt. Upgrade auf einen höheren Plan um mehr Workflows zu erstellen.`,
        upgradeUrl,
        {
          current_count: currentCount,
          limit,
          plan: tenant.plan,
          next_plan: getNextPlan(tenant.plan),
        }
      );
    }

    next();
  } catch (err) {
    console.error('[PlanLimits] checkWorkflowLimit Fehler:', err);
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Middleware 2: checkAgentTypeAllowed(agentType)
// Prüft ob ein bestimmter Agent-Typ im aktuellen Plan enthalten ist.
// ---------------------------------------------------------------------------

/**
 * @middleware checkAgentTypeAllowed
 * Factory-Funktion: gibt eine Middleware zurück die den angegebenen agentType prüft.
 *
 * @param {string} agentType — Agent-Typ aus Request-Body/Params, oder statischer String
 * @returns {Function} Express Middleware
 *
 * Verwendung:
 *   // Statischer Typ:
 *   router.post('/tasks/marketing', checkAgentTypeAllowed('marketing'), handler);
 *
 *   // Dynamisch aus Request-Body:
 *   router.post('/tasks', checkAgentTypeAllowed(null), handler); // liest req.body.agent_type
 */
function checkAgentTypeAllowed(staticAgentType = null) {
  return async function (req, res, next) {
    try {
      // Agent-Typ aus Parameter oder Request-Body
      const agentType = staticAgentType || req.body?.agent_type || req.params?.agent_type;

      if (!agentType) {
        // Kein Agent-Typ angegeben → kein Check notwendig
        return next();
      }

      const tenant = await loadTenantData(req);
      const planConfig = PLANS[tenant.plan] || PLANS.free;
      const allowedTypes = planConfig.limits.allowed_agent_types || [];

      if (!allowedTypes.includes(agentType)) {
        const upgradeUrl = getUpgradeUrl();
        return sendPaymentRequired(
          res,
          'Agent-Typ nicht verfügbar',
          `Der Agent-Typ '${agentType}' ist in deinem ${planConfig.name}-Plan nicht verfügbar. Verfügbare Typen: ${allowedTypes.join(', ')}. Upgrade auf Professional oder Enterprise um alle Agent-Typen zu nutzen.`,
          upgradeUrl,
          {
            requested_agent_type: agentType,
            allowed_agent_types: allowedTypes,
            plan: tenant.plan,
            next_plan: getNextPlan(tenant.plan),
          }
        );
      }

      next();
    } catch (err) {
      console.error('[PlanLimits] checkAgentTypeAllowed Fehler:', err);
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Middleware 3: checkMonthlyRunLimit
// Prüft ob das monatliche Agent-Run-Limit erreicht ist.
// ---------------------------------------------------------------------------

/**
 * @middleware checkMonthlyRunLimit
 * Blockiert Workflow-Ausführungen wenn das monatliche Limit überschritten ist.
 */
async function checkMonthlyRunLimit(req, res, next) {
  try {
    const tenant = await loadTenantData(req);
    const planConfig = PLANS[tenant.plan] || PLANS.free;
    const limit = planConfig.limits.max_agent_runs_per_month;

    // Unlimited-Plan: direkt weiter
    if (limit === -1) return next();

    // Billing-Zeitraum: erster Tag des aktuellen Monats
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Agent-Runs im aktuellen Monat zählen
    const result = await db.query(
      `SELECT COUNT(*) AS count
       FROM agent_runs ar
       JOIN tasks t ON ar.task_id = t.id
       JOIN workflows w ON t.workflow_id = w.id
       WHERE w.tenant_id = $1 AND ar.created_at >= $2`,
      [req.tenant_id, periodStart.toISOString()]
    );
    const currentCount = parseInt(result.rows[0].count, 10);

    if (isLimitExceeded(limit, currentCount)) {
      const upgradeUrl = getUpgradeUrl();

      // Nächster Reset: erster Tag des Folgemonats
      const resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);

      return sendPaymentRequired(
        res,
        'Monatliches Agent-Run-Limit erreicht',
        `Dein ${planConfig.name}-Plan erlaubt ${limit} Agent-Runs pro Monat. Du hast in diesem Monat bereits ${currentCount} Runs verbraucht. Das Limit wird am ${resetDate.toLocaleDateString('de-DE')} zurückgesetzt oder upgrade deinen Plan für mehr Kapazität.`,
        upgradeUrl,
        {
          current_runs_this_month: currentCount,
          monthly_limit: limit,
          period_start: periodStart.toISOString(),
          limit_resets_at: resetDate.toISOString(),
          plan: tenant.plan,
          next_plan: getNextPlan(tenant.plan),
          usage_percentage: Math.round((currentCount / limit) * 100),
        }
      );
    }

    // Verbleibende Runs an den Request anheften (für Response-Header o.ä.)
    req.remainingRuns = limit - currentCount;
    res.setHeader('X-RateLimit-Runs-Remaining', req.remainingRuns);
    res.setHeader('X-RateLimit-Runs-Limit', limit);

    next();
  } catch (err) {
    console.error('[PlanLimits] checkMonthlyRunLimit Fehler:', err);
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Middleware 4: checkGatewayLimit (Bonus)
// Prüft ob das Gateway-Limit erreicht ist.
// ---------------------------------------------------------------------------

/**
 * @middleware checkGatewayLimit
 * Blockiert Gateway-Registrierungen wenn das Limit überschritten ist.
 */
async function checkGatewayLimit(req, res, next) {
  try {
    const tenant = await loadTenantData(req);
    const planConfig = PLANS[tenant.plan] || PLANS.free;
    const limit = planConfig.limits.max_gateways;

    if (limit === -1) return next();

    const result = await db.query(
      "SELECT COUNT(*) AS count FROM gateways WHERE tenant_id = $1 AND status != 'deleted'",
      [req.tenant_id]
    );
    const currentCount = parseInt(result.rows[0].count, 10);

    if (isLimitExceeded(limit, currentCount)) {
      const upgradeUrl = getUpgradeUrl();
      return sendPaymentRequired(
        res,
        'Gateway-Limit erreicht',
        `Dein ${planConfig.name}-Plan erlaubt maximal ${limit} Gateways. Du hast bereits ${currentCount} aktive Gateways registriert.`,
        upgradeUrl,
        {
          current_count: currentCount,
          limit,
          plan: tenant.plan,
          next_plan: getNextPlan(tenant.plan),
        }
      );
    }

    next();
  } catch (err) {
    console.error('[PlanLimits] checkGatewayLimit Fehler:', err);
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Middleware 5: checkFeatureFlag(featureKey)
// Prüft ob ein Feature im Plan aktiviert ist (compliance_reports, human_approval etc.)
// ---------------------------------------------------------------------------

/**
 * @middleware checkFeatureFlag
 * Factory-Funktion: gibt Middleware zurück die einen Boolean-Feature-Flag prüft.
 *
 * @param {string} featureKey — Key aus planConfig.limits (z.B. 'compliance_reports')
 * @returns {Function} Express Middleware
 *
 * Verwendung:
 *   router.post('/compliance/generate', checkFeatureFlag('compliance_reports'), handler);
 *   router.post('/workflows/:id/approve', checkFeatureFlag('human_approval'), handler);
 */
function checkFeatureFlag(featureKey) {
  return async function (req, res, next) {
    try {
      const tenant = await loadTenantData(req);
      const planConfig = PLANS[tenant.plan] || PLANS.free;
      const featureEnabled = planConfig.limits[featureKey];

      if (!featureEnabled) {
        const upgradeUrl = getUpgradeUrl();
        return sendPaymentRequired(
          res,
          'Feature nicht verfügbar',
          `Das Feature '${featureKey}' ist in deinem ${planConfig.name}-Plan nicht enthalten. Upgrade auf Starter oder höher um dieses Feature zu nutzen.`,
          upgradeUrl,
          {
            feature: featureKey,
            plan: tenant.plan,
            next_plan: getNextPlan(tenant.plan),
          }
        );
      }

      next();
    } catch (err) {
      console.error('[PlanLimits] checkFeatureFlag Fehler:', err);
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Hilfsfunktion: nächsten Plan ermitteln
// ---------------------------------------------------------------------------

/**
 * Gibt den nächst höheren Plan zurück.
 * @param {string} currentPlan
 * @returns {string|null}
 */
function getNextPlan(currentPlan) {
  const planOrder = ['free', 'starter', 'professional', 'enterprise'];
  const currentIndex = planOrder.indexOf(currentPlan);
  if (currentIndex === -1 || currentIndex === planOrder.length - 1) return null;
  return planOrder[currentIndex + 1];
}

module.exports = {
  checkWorkflowLimit,
  checkAgentTypeAllowed,
  checkMonthlyRunLimit,
  checkGatewayLimit,
  checkFeatureFlag,
};
