'use strict';

/**
 * Stripe Webhook Handler
 * RealSyncDynamics Agent-OS
 *
 * Raw body parsing is applied in app.js before this route.
 * Stripe signature is verified immediately; async processing runs in background.
 */

const express = require('express');
const stripe = require('../config/stripe');
const pool = require('../db');
const { getPlanByPriceId } = require('../config/plans');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helper: map Stripe price IDs (from env) to internal plan names
// ---------------------------------------------------------------------------
function priceIdToPlan(priceId) {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_STARTER_PRICE_ID)      return 'starter';
  if (priceId === process.env.STRIPE_PROFESSIONAL_PRICE_ID) return 'professional';
  if (priceId === process.env.STRIPE_ENTERPRISE_PRICE_ID)   return 'enterprise';
  // Fallback: try plans config
  try {
    return getPlanByPriceId(priceId) || null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: structured logger
// ---------------------------------------------------------------------------
function logInfo(event, data = {}) {
  console.log(JSON.stringify({ level: 'info', event, ...data, ts: new Date().toISOString() }));
}

function logError(event, err, data = {}) {
  console.error(JSON.stringify({
    level: 'error',
    event,
    message: err?.message ?? String(err),
    stack: err?.stack ?? null,
    ...data,
    ts: new Date().toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Helper: compute plan_expires_at from a Stripe subscription object
// Stripe current_period_end is a Unix timestamp (seconds).
// ---------------------------------------------------------------------------
function planExpiresAt(subscription) {
  if (!subscription?.current_period_end) return null;
  return new Date(subscription.current_period_end * 1000);
}

// ---------------------------------------------------------------------------
// Helper: resolve tenant_id from stripe_customer_id
// ---------------------------------------------------------------------------
async function tenantIdByCustomer(client, stripeCustomerId) {
  const { rows } = await client.query(
    'SELECT id FROM tenants WHERE stripe_customer_id = $1 LIMIT 1',
    [stripeCustomerId]
  );
  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Event handlers — all run in background after 200 is returned to Stripe
// ---------------------------------------------------------------------------

async function handleSubscriptionCreated(subscription) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const customerId = subscription.customer;
    const priceId    = subscription.items?.data?.[0]?.price?.id ?? null;
    const plan       = priceIdToPlan(priceId) ?? 'starter';
    const expiresAt  = planExpiresAt(subscription);

    // Upsert by stripe_customer_id
    await client.query(
      `UPDATE tenants
          SET plan            = $2,
              plan_expires_at = $3,
              stripe_subscription_id = $4,
              updated_at      = NOW()
        WHERE stripe_customer_id = $1`,
      [customerId, plan, expiresAt, subscription.id]
    );

    await client.query('COMMIT');
    logInfo('subscription.created.processed', { customerId, plan, subscriptionId: subscription.id });
  } catch (err) {
    await client.query('ROLLBACK');
    logError('subscription.created.failed', err, { subscriptionId: subscription.id });
  } finally {
    client.release();
  }
}

async function handleSubscriptionUpdated(subscription) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const customerId = subscription.customer;
    const priceId    = subscription.items?.data?.[0]?.price?.id ?? null;
    const plan       = priceIdToPlan(priceId);
    const expiresAt  = planExpiresAt(subscription);

    if (!plan) {
      logInfo('subscription.updated.unknown_price', { customerId, priceId });
    }

    await client.query(
      `UPDATE tenants
          SET plan            = COALESCE($2, plan),
              plan_expires_at = $3,
              stripe_subscription_id = $4,
              updated_at      = NOW()
        WHERE stripe_customer_id = $1`,
      [customerId, plan, expiresAt, subscription.id]
    );

    await client.query('COMMIT');
    logInfo('subscription.updated.processed', { customerId, plan, subscriptionId: subscription.id });
  } catch (err) {
    await client.query('ROLLBACK');
    logError('subscription.updated.failed', err, { subscriptionId: subscription.id });
  } finally {
    client.release();
  }
}

async function handleSubscriptionDeleted(subscription) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const customerId = subscription.customer;

    await client.query(
      `UPDATE tenants
          SET plan                   = 'free',
              plan_expires_at        = NULL,
              stripe_subscription_id = NULL,
              updated_at             = NOW()
        WHERE stripe_customer_id = $1`,
      [customerId]
    );

    await client.query('COMMIT');
    logInfo('subscription.deleted.processed', { customerId, subscriptionId: subscription.id });
  } catch (err) {
    await client.query('ROLLBACK');
    logError('subscription.deleted.failed', err, { subscriptionId: subscription.id });
  } finally {
    client.release();
  }
}

async function handleInvoicePaymentSucceeded(invoice) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const customerId = invoice.customer;
    const tenantId   = await tenantIdByCustomer(client, customerId);

    await client.query(
      `UPDATE tenants
          SET payment_status = 'active',
              updated_at     = NOW()
        WHERE stripe_customer_id = $1`,
      [customerId]
    );

    // Audit log
    if (tenantId) {
      await client.query(
        `INSERT INTO audit_logs (tenant_id, action, actor, metadata, created_at)
         VALUES ($1, 'invoice.payment_succeeded', 'stripe', $2, NOW())`,
        [
          tenantId,
          JSON.stringify({
            invoice_id:  invoice.id,
            amount_paid: invoice.amount_paid,
            currency:    invoice.currency,
            hosted_invoice_url: invoice.hosted_invoice_url ?? null,
          }),
        ]
      );
    }

    await client.query('COMMIT');
    logInfo('invoice.payment_succeeded.processed', { customerId, invoiceId: invoice.id });
  } catch (err) {
    await client.query('ROLLBACK');
    logError('invoice.payment_succeeded.failed', err, { invoiceId: invoice.id });
  } finally {
    client.release();
  }
}

async function handleInvoicePaymentFailed(invoice) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const customerId = invoice.customer;

    await client.query(
      `UPDATE tenants
          SET payment_status = 'past_due',
              updated_at     = NOW()
        WHERE stripe_customer_id = $1`,
      [customerId]
    );

    await client.query('COMMIT');
    logInfo('invoice.payment_failed.processed', { customerId, invoiceId: invoice.id });

    // Notification — fire-and-forget; send via your notification service
    // e.g. notificationService.sendPaymentFailedAlert(customerId, invoice);
    // Kept as a no-op stub to avoid import coupling at this layer.
    logInfo('invoice.payment_failed.notification_stub', {
      note:       'Wire up notification service here',
      customerId,
      invoiceId:  invoice.id,
      attemptCount: invoice.attempt_count ?? null,
      nextAttempt:  invoice.next_payment_attempt ?? null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logError('invoice.payment_failed.failed', err, { invoiceId: invoice.id });
  } finally {
    client.release();
  }
}

async function handleCheckoutSessionCompleted(session) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const stripeCustomerId     = session.customer;
    const stripeSubscriptionId = session.subscription;
    // client_reference_id is set during checkout creation to link the tenant
    const tenantId             = session.client_reference_id ?? null;

    if (!tenantId) {
      logInfo('checkout.session.completed.no_tenant_ref', { sessionId: session.id });
      await client.query('COMMIT');
      return;
    }

    // Link stripe customer_id to tenant
    await client.query(
      `UPDATE tenants
          SET stripe_customer_id     = $2,
              stripe_subscription_id = $3,
              updated_at             = NOW()
        WHERE id = $1`,
      [tenantId, stripeCustomerId, stripeSubscriptionId]
    );

    // Activate subscription if present
    if (stripeSubscriptionId) {
      // Fetch subscription to get plan details
      let plan       = null;
      let expiresAt  = null;

      try {
        const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
        const priceId = sub.items?.data?.[0]?.price?.id ?? null;
        plan      = priceIdToPlan(priceId);
        expiresAt = planExpiresAt(sub);
      } catch (subErr) {
        logError('checkout.session.completed.sub_retrieve_failed', subErr, { stripeSubscriptionId });
      }

      await client.query(
        `UPDATE tenants
            SET plan            = COALESCE($2, plan),
                plan_expires_at = $3,
                payment_status  = 'active',
                updated_at      = NOW()
          WHERE id = $1`,
        [tenantId, plan, expiresAt]
      );
    }

    await client.query('COMMIT');
    logInfo('checkout.session.completed.processed', { tenantId, stripeCustomerId, stripeSubscriptionId });
  } catch (err) {
    await client.query('ROLLBACK');
    logError('checkout.session.completed.failed', err, { sessionId: session.id });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------
const EVENT_HANDLERS = {
  'customer.subscription.created':  (e) => handleSubscriptionCreated(e.data.object),
  'customer.subscription.updated':  (e) => handleSubscriptionUpdated(e.data.object),
  'customer.subscription.deleted':  (e) => handleSubscriptionDeleted(e.data.object),
  'invoice.payment_succeeded':      (e) => handleInvoicePaymentSucceeded(e.data.object),
  'invoice.payment_failed':         (e) => handleInvoicePaymentFailed(e.data.object),
  'checkout.session.completed':     (e) => handleCheckoutSessionCompleted(e.data.object),
};

// ---------------------------------------------------------------------------
// POST /stripe/webhook
// ---------------------------------------------------------------------------
router.post('/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];

  // Verify signature synchronously — fail fast if invalid
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      req.body, // Buffer, raw body applied by app.js
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    logError('stripe.webhook.signature_invalid', err);
    return res.status(400).json({
      type:     'https://realsync.io/problems/webhook-signature-invalid',
      title:    'Webhook signature verification failed',
      status:   400,
      detail:   err.message,
      instance: req.originalUrl,
    });
  }

  // Acknowledge immediately — Stripe requires a fast 200
  res.sendStatus(200);

  // Process asynchronously so we never time out Stripe
  const handler = EVENT_HANDLERS[stripeEvent.type];
  if (handler) {
    handler(stripeEvent).catch((err) =>
      logError('stripe.webhook.handler_uncaught', err, { eventType: stripeEvent.type, eventId: stripeEvent.id })
    );
  } else {
    logInfo('stripe.webhook.unhandled_event', { eventType: stripeEvent.type, eventId: stripeEvent.id });
  }
});

module.exports = router;
