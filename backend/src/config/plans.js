'use strict';

/**
 * RealSyncDynamics — Plan-Konfiguration
 * Zentrale Quelle der Wahrheit für alle Plan-Limits und Stripe Price IDs.
 * Wird von: billing routes, plan-limits middleware, webhook handler verwendet.
 */

const PLANS = {
  free: {
    name: 'Free',
    price_monthly: 0,
    stripe_price_id: null,
    limits: {
      max_workflows: 3,
      max_gateways: 1,
      max_agent_runs_per_month: 100,
      allowed_agent_types: ['devops'],
      openclaw_enabled: true,
      compliance_reports: false,
      human_approval: false,
    },
  },

  starter: {
    name: 'Starter',
    price_monthly: 29,
    stripe_price_id: process.env.STRIPE_STARTER_PRICE_ID,
    limits: {
      max_workflows: 25,
      max_gateways: 5,
      max_agent_runs_per_month: 2500,
      allowed_agent_types: ['devops', 'marketing'],
      openclaw_enabled: true,
      compliance_reports: true,
      human_approval: false,
    },
  },

  professional: {
    name: 'Professional',
    price_monthly: 99,
    stripe_price_id: process.env.STRIPE_PROFESSIONAL_PRICE_ID,
    limits: {
      max_workflows: 100,
      max_gateways: 20,
      max_agent_runs_per_month: 15000,
      allowed_agent_types: ['devops', 'marketing', 'compliance', 'research'],
      openclaw_enabled: true,
      compliance_reports: true,
      human_approval: true,
    },
  },

  enterprise: {
    name: 'Enterprise',
    price_monthly: null, // Custom pricing — Kontakt erforderlich
    stripe_price_id: process.env.STRIPE_ENTERPRISE_PRICE_ID,
    limits: {
      max_workflows: -1,        // -1 = unlimitiert
      max_gateways: -1,
      max_agent_runs_per_month: -1,
      allowed_agent_types: ['devops', 'marketing', 'compliance', 'research', 'manager'],
      openclaw_enabled: true,
      compliance_reports: true,
      human_approval: true,
      sla: '99.9%',
    },
  },
};

/**
 * Hilfsfunktion: Plan anhand der Stripe Price ID ermitteln.
 * Wird im Webhook-Handler verwendet.
 * @param {string} stripePriceId
 * @returns {string|null} Plan-Key (z.B. 'starter') oder null
 */
function getPlanByStripePriceId(stripePriceId) {
  if (!stripePriceId) return null;
  for (const [key, plan] of Object.entries(PLANS)) {
    if (plan.stripe_price_id === stripePriceId) {
      return key;
    }
  }
  return null;
}

/**
 * Hilfsfunktion: Prüft ob ein Limit überschritten wurde.
 * -1 bedeutet unlimitiert.
 * @param {number} limit  Plan-Limit
 * @param {number} current Aktueller Wert
 * @returns {boolean} true = Limit überschritten
 */
function isLimitExceeded(limit, current) {
  if (limit === -1) return false; // unlimited
  return current >= limit;
}

/**
 * Hilfsfunktion: Gibt die öffentliche Upgrade-URL zurück.
 * @returns {string}
 */
function getUpgradeUrl() {
  return process.env.APP_FRONTEND_URL
    ? `${process.env.APP_FRONTEND_URL}/billing/upgrade`
    : 'https://app.realsyncdynamics.com/billing/upgrade';
}

module.exports = {
  PLANS,
  getPlanByStripePriceId,
  isLimitExceeded,
  getUpgradeUrl,
};
