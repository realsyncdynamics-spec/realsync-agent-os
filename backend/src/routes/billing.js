'use strict';

/**
 * RealSyncDynamics — Billing Routes
 * Vollständiger Express Router für Stripe-basiertes Subscription-Billing.
 *
 * Alle Endpunkte erfordern authentifizierten Request (req.tenant_id gesetzt durch Auth-Middleware).
 * Stripe-Fehler und DB-Fehler werden im RFC 9457 Format zurückgegeben.
 */

const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const db = require('../db'); // Pool-Instanz (pg / knex o.ä.)
const { PLANS, getUpgradeUrl } = require('../config/plans');

// Stripe-Client initialisieren
const stripe = Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
  appInfo: {
    name: 'RealSyncDynamics',
    version: '1.0.0',
  },
});

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * Gibt eine RFC 9457 konforme Fehlerantwort zurück.
 */
function sendProblem(res, status, title, detail, extra = {}) {
  return res.status(status).json({
    type: `https://realsyncdynamics.com/errors/${slugify(title)}`,
    title,
    status,
    detail,
    instance: res.req.originalUrl,
    ...extra,
  });
}

function slugify(str) {
  return str.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

/**
 * Lädt Tenant aus DB inkl. Stripe Customer ID und aktuellem Plan.
 */
async function getTenant(tenantId) {
  const result = await db.query(
    'SELECT id, name, plan, stripe_customer_id, settings FROM tenants WHERE id = $1',
    [tenantId]
  );
  return result.rows[0] || null;
}

/**
 * Erstellt oder gibt bestehende Stripe Customer ID zurück.
 */
async function getOrCreateStripeCustomer(tenant) {
  if (tenant.stripe_customer_id) {
    return tenant.stripe_customer_id;
  }

  // Neuen Stripe-Kunden anlegen
  const customer = await stripe.customers.create({
    name: tenant.name,
    metadata: {
      tenant_id: tenant.id,
    },
  });

  // Stripe Customer ID in DB speichern
  await db.query(
    'UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2',
    [customer.id, tenant.id]
  );

  return customer.id;
}

// ---------------------------------------------------------------------------
// GET /billing/subscription
// Aktuelle Subscription + Plan-Details abrufen
// ---------------------------------------------------------------------------
router.get('/subscription', async (req, res) => {
  try {
    const tenant = await getTenant(req.tenant_id);
    if (!tenant) {
      return sendProblem(res, 404, 'Tenant not found', 'Der angeforderte Tenant wurde nicht gefunden.');
    }

    const planConfig = PLANS[tenant.plan] || PLANS.free;
    let stripeSubscription = null;

    // Stripe-Subscription abrufen falls Kunde existiert
    if (tenant.stripe_customer_id) {
      const subscriptions = await stripe.subscriptions.list({
        customer: tenant.stripe_customer_id,
        status: 'all',
        limit: 1,
        expand: ['data.default_payment_method', 'data.items.data.price'],
      });
      stripeSubscription = subscriptions.data[0] || null;
    }

    return res.json({
      plan: tenant.plan,
      plan_name: planConfig.name,
      price_monthly: planConfig.price_monthly,
      limits: planConfig.limits,
      subscription: stripeSubscription
        ? {
            id: stripeSubscription.id,
            status: stripeSubscription.status,
            current_period_start: new Date(stripeSubscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(stripeSubscription.current_period_end * 1000).toISOString(),
            cancel_at_period_end: stripeSubscription.cancel_at_period_end,
            payment_method: stripeSubscription.default_payment_method
              ? {
                  brand: stripeSubscription.default_payment_method.card?.brand,
                  last4: stripeSubscription.default_payment_method.card?.last4,
                  exp_month: stripeSubscription.default_payment_method.card?.exp_month,
                  exp_year: stripeSubscription.default_payment_method.card?.exp_year,
                }
              : null,
          }
        : null,
    });
  } catch (err) {
    console.error('[Billing] GET /subscription error:', err);
    if (err.type?.startsWith('Stripe')) {
      return sendProblem(res, 502, 'Stripe Error', `Stripe-Kommunikationsfehler: ${err.message}`);
    }
    return sendProblem(res, 500, 'Internal Server Error', 'Subscription konnte nicht abgerufen werden.');
  }
});

// ---------------------------------------------------------------------------
// POST /billing/checkout
// Stripe Checkout Session erstellen
// Body: { plan: 'starter' | 'professional' | 'enterprise' }
// ---------------------------------------------------------------------------
router.post('/checkout', async (req, res) => {
  try {
    const { plan } = req.body;

    if (!plan || !['starter', 'professional', 'enterprise'].includes(plan)) {
      return sendProblem(res, 400, 'Invalid Plan', `Ungültiger Plan '${plan}'. Erlaubt: starter, professional, enterprise.`);
    }

    const planConfig = PLANS[plan];
    if (!planConfig.stripe_price_id) {
      return sendProblem(res, 400, 'Plan Not Available', `Plan '${plan}' hat keine Stripe Price ID. Bitte kontaktiere den Support für Enterprise-Pricing.`);
    }

    const tenant = await getTenant(req.tenant_id);
    if (!tenant) {
      return sendProblem(res, 404, 'Tenant not found', 'Der Tenant wurde nicht gefunden.');
    }

    const customerId = await getOrCreateStripeCustomer(tenant);

    const frontendUrl = process.env.APP_FRONTEND_URL || 'https://app.realsyncdynamics.com';

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [
        {
          price: planConfig.stripe_price_id,
          quantity: 1,
        },
      ],
      success_url: `${frontendUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/billing/cancelled`,
      metadata: {
        tenant_id: req.tenant_id,
        plan,
      },
      subscription_data: {
        metadata: {
          tenant_id: req.tenant_id,
          plan,
        },
      },
      allow_promotion_codes: true,
    });

    return res.status(201).json({
      checkout_url: session.url,
      session_id: session.id,
    });
  } catch (err) {
    console.error('[Billing] POST /checkout error:', err);
    if (err.type?.startsWith('Stripe')) {
      return sendProblem(res, 502, 'Stripe Error', `Checkout konnte nicht erstellt werden: ${err.message}`);
    }
    return sendProblem(res, 500, 'Internal Server Error', 'Checkout Session konnte nicht erstellt werden.');
  }
});

// ---------------------------------------------------------------------------
// POST /billing/portal
// Stripe Customer Portal Link generieren
// ---------------------------------------------------------------------------
router.post('/portal', async (req, res) => {
  try {
    const tenant = await getTenant(req.tenant_id);
    if (!tenant) {
      return sendProblem(res, 404, 'Tenant not found', 'Der Tenant wurde nicht gefunden.');
    }

    if (!tenant.stripe_customer_id) {
      return sendProblem(res, 400, 'No Stripe Customer', 'Kein Stripe-Konto verknüpft. Bitte zuerst eine Subscription abschließen.');
    }

    const frontendUrl = process.env.APP_FRONTEND_URL || 'https://app.realsyncdynamics.com';

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: tenant.stripe_customer_id,
      return_url: `${frontendUrl}/settings/billing`,
    });

    return res.json({
      portal_url: portalSession.url,
    });
  } catch (err) {
    console.error('[Billing] POST /portal error:', err);
    if (err.type?.startsWith('Stripe')) {
      return sendProblem(res, 502, 'Stripe Error', `Customer Portal konnte nicht geöffnet werden: ${err.message}`);
    }
    return sendProblem(res, 500, 'Internal Server Error', 'Customer Portal Session konnte nicht erstellt werden.');
  }
});

// ---------------------------------------------------------------------------
// POST /billing/cancel
// Subscription kündigen (am Ende der aktuellen Periode)
// ---------------------------------------------------------------------------
router.post('/cancel', async (req, res) => {
  try {
    const tenant = await getTenant(req.tenant_id);
    if (!tenant) {
      return sendProblem(res, 404, 'Tenant not found', 'Der Tenant wurde nicht gefunden.');
    }

    if (!tenant.stripe_customer_id) {
      return sendProblem(res, 400, 'No Active Subscription', 'Keine aktive Subscription gefunden.');
    }

    // Aktive Subscription finden
    const subscriptions = await stripe.subscriptions.list({
      customer: tenant.stripe_customer_id,
      status: 'active',
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
      return sendProblem(res, 404, 'Subscription Not Found', 'Keine aktive Subscription gefunden, die gekündigt werden kann.');
    }

    const subscription = subscriptions.data[0];

    // Kündigung am Ende der Periode (kein sofortiger Verlust des Zugangs)
    const updated = await stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: true,
    });

    // Audit-Log schreiben
    await db.query(
      `INSERT INTO audit_logs (tenant_id, event_type, details, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [
        req.tenant_id,
        'subscription.cancel_requested',
        JSON.stringify({
          subscription_id: subscription.id,
          cancel_at: new Date(updated.cancel_at * 1000).toISOString(),
          requested_by: req.user_id,
        }),
      ]
    );

    return res.json({
      message: 'Subscription wird am Ende der aktuellen Abrechnungsperiode gekündigt.',
      subscription_id: subscription.id,
      cancel_at: new Date(updated.cancel_at * 1000).toISOString(),
      access_until: new Date(updated.current_period_end * 1000).toISOString(),
    });
  } catch (err) {
    console.error('[Billing] POST /cancel error:', err);
    if (err.type?.startsWith('Stripe')) {
      return sendProblem(res, 502, 'Stripe Error', `Kündigung fehlgeschlagen: ${err.message}`);
    }
    return sendProblem(res, 500, 'Internal Server Error', 'Subscription konnte nicht gekündigt werden.');
  }
});

// ---------------------------------------------------------------------------
// GET /billing/invoices
// Rechnungshistorie (letzte 10)
// ---------------------------------------------------------------------------
router.get('/invoices', async (req, res) => {
  try {
    const tenant = await getTenant(req.tenant_id);
    if (!tenant) {
      return sendProblem(res, 404, 'Tenant not found', 'Der Tenant wurde nicht gefunden.');
    }

    if (!tenant.stripe_customer_id) {
      return res.json({ invoices: [], total: 0 });
    }

    const invoices = await stripe.invoices.list({
      customer: tenant.stripe_customer_id,
      limit: 10,
      expand: ['data.subscription'],
    });

    const formatted = invoices.data.map((inv) => ({
      id: inv.id,
      number: inv.number,
      status: inv.status,
      amount_paid: inv.amount_paid / 100,
      currency: inv.currency.toUpperCase(),
      period_start: new Date(inv.period_start * 1000).toISOString(),
      period_end: new Date(inv.period_end * 1000).toISOString(),
      created: new Date(inv.created * 1000).toISOString(),
      pdf_url: inv.invoice_pdf,
      hosted_url: inv.hosted_invoice_url,
      plan: inv.subscription?.metadata?.plan || null,
    }));

    return res.json({
      invoices: formatted,
      total: formatted.length,
      has_more: invoices.has_more,
    });
  } catch (err) {
    console.error('[Billing] GET /invoices error:', err);
    if (err.type?.startsWith('Stripe')) {
      return sendProblem(res, 502, 'Stripe Error', `Rechnungen konnten nicht abgerufen werden: ${err.message}`);
    }
    return sendProblem(res, 500, 'Internal Server Error', 'Rechnungshistorie konnte nicht geladen werden.');
  }
});

// ---------------------------------------------------------------------------
// GET /billing/usage
// Usage-Metriken für aktuellen Billing-Zeitraum
// ---------------------------------------------------------------------------
router.get('/usage', async (req, res) => {
  try {
    const tenant = await getTenant(req.tenant_id);
    if (!tenant) {
      return sendProblem(res, 404, 'Tenant not found', 'Der Tenant wurde nicht gefunden.');
    }

    const planConfig = PLANS[tenant.plan] || PLANS.free;

    // Billing-Zeitraum: erster Tag des aktuellen Monats bis jetzt
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Usage-Daten aus DB aggregieren
    const [workflowCount, agentRunCount, apiCallCount, activeGateways] = await Promise.all([
      // Anzahl Workflows
      db.query(
        'SELECT COUNT(*) AS count FROM workflows WHERE tenant_id = $1',
        [req.tenant_id]
      ),
      // Agent-Runs im aktuellen Monat
      db.query(
        `SELECT COUNT(*) AS count
         FROM agent_runs ar
         JOIN tasks t ON ar.task_id = t.id
         JOIN workflows w ON t.workflow_id = w.id
         WHERE w.tenant_id = $1 AND ar.created_at >= $2`,
        [req.tenant_id, periodStart.toISOString()]
      ),
      // API-Calls im aktuellen Monat (optional: aus access_logs)
      db.query(
        `SELECT COUNT(*) AS count
         FROM access_logs
         WHERE tenant_id = $1 AND created_at >= $2`,
        [req.tenant_id, periodStart.toISOString()]
      ).catch(() => ({ rows: [{ count: 0 }] })), // graceful fallback
      // Aktive Gateways
      db.query(
        `SELECT COUNT(*) AS count FROM gateways
         WHERE tenant_id = $1 AND status != 'deleted'`,
        [req.tenant_id]
      ),
    ]);

    const workflows = parseInt(workflowCount.rows[0].count, 10);
    const agentRuns = parseInt(agentRunCount.rows[0].count, 10);
    const apiCalls = parseInt(apiCallCount.rows[0].count, 10);
    const gateways = parseInt(activeGateways.rows[0].count, 10);

    const limits = planConfig.limits;

    return res.json({
      period: {
        start: periodStart.toISOString(),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString(),
      },
      plan: tenant.plan,
      usage: {
        workflows: {
          current: workflows,
          limit: limits.max_workflows,
          unlimited: limits.max_workflows === -1,
          percentage: limits.max_workflows === -1 ? null : Math.round((workflows / limits.max_workflows) * 100),
        },
        agent_runs: {
          current: agentRuns,
          limit: limits.max_agent_runs_per_month,
          unlimited: limits.max_agent_runs_per_month === -1,
          percentage: limits.max_agent_runs_per_month === -1
            ? null
            : Math.round((agentRuns / limits.max_agent_runs_per_month) * 100),
        },
        gateways: {
          current: gateways,
          limit: limits.max_gateways,
          unlimited: limits.max_gateways === -1,
          percentage: limits.max_gateways === -1 ? null : Math.round((gateways / limits.max_gateways) * 100),
        },
        api_calls: {
          current: apiCalls,
          note: 'Gesamte API-Calls im Abrechnungszeitraum (informativ)',
        },
      },
      upgrade_url: getUpgradeUrl(),
    });
  } catch (err) {
    console.error('[Billing] GET /usage error:', err);
    return sendProblem(res, 500, 'Internal Server Error', 'Usage-Daten konnten nicht abgerufen werden.');
  }
});

module.exports = router;
