'use strict';

/**
 * RealSyncDynamics — Stripe Webhook Handler
 * Verarbeitet alle eingehenden Stripe-Events.
 *
 * WICHTIG: Dieser Router muss BEFORE bodyParser.json() eingebunden werden,
 * damit der raw body für die Signatur-Verifikation verfügbar ist.
 *
 * Einbindung in app.js:
 *   app.use('/stripe/webhook', require('./routes/stripe-webhook'));
 *   app.use(express.json()); // bodyParser DANACH
 */

const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const db = require('../db');
const { PLANS, getPlanByStripePriceId } = require('../config/plans');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

// ---------------------------------------------------------------------------
// Idempotenz: Set der bereits verarbeiteten Event-IDs (In-Memory)
// In Produktion: Redis oder DB-Tabelle `processed_events` verwenden.
// ---------------------------------------------------------------------------
const processedEvents = new Set();

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

/**
 * Schreibt einen Eintrag in audit_logs.
 */
async function writeAuditLog(tenantId, eventType, details, stripeEventId) {
  try {
    await db.query(
      `INSERT INTO audit_logs (tenant_id, event_type, details, stripe_event_id, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [tenantId, eventType, JSON.stringify(details), stripeEventId || null]
    );
  } catch (err) {
    // Audit-Log Fehler darf Webhook-Verarbeitung nicht blockieren
    console.error('[Webhook] Audit-Log Fehler:', err.message);
  }
}

/**
 * Sendet eine Benachrichtigungs-Mail (Placeholder — eigenen Mail-Service einbinden).
 */
async function sendEmail(to, subject, body) {
  try {
    // Eigene Mail-Integration (z.B. Resend, SendGrid, SES) hier einfügen
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Email] An: ${to} | Betreff: ${subject}`);
      return;
    }
    // Beispiel: await resend.emails.send({ from: 'noreply@realsyncdynamics.com', to, subject, html: body });
  } catch (err) {
    console.error('[Webhook] E-Mail Fehler:', err.message);
  }
}

/**
 * Tenant anhand der Stripe Customer ID laden.
 */
async function getTenantByCustomerId(customerId) {
  const result = await db.query(
    'SELECT id, name, plan, settings FROM tenants WHERE stripe_customer_id = $1',
    [customerId]
  );
  return result.rows[0] || null;
}

/**
 * Admin-E-Mail-Adresse(n) aus der DB oder ENV laden.
 */
async function getAdminEmails() {
  const envAdmins = process.env.ADMIN_NOTIFICATION_EMAILS;
  if (envAdmins) return envAdmins.split(',').map((e) => e.trim());
  try {
    const result = await db.query(
      "SELECT email FROM users WHERE role = 'admin' AND is_active = true LIMIT 10"
    );
    return result.rows.map((r) => r.email);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Event-Handler
// ---------------------------------------------------------------------------

/**
 * customer.subscription.created
 * Wird aufgerufen wenn eine neue Subscription angelegt wurde.
 * Tenant-Plan aktualisieren, Welcome-Mail senden.
 */
async function handleSubscriptionCreated(event) {
  const subscription = event.data.object;
  const tenant = await getTenantByCustomerId(subscription.customer);

  if (!tenant) {
    console.warn('[Webhook] subscription.created: Kein Tenant für Customer', subscription.customer);
    return;
  }

  const priceId = subscription.items?.data?.[0]?.price?.id;
  const newPlan = getPlanByStripePriceId(priceId) || 'starter';
  const planConfig = PLANS[newPlan];

  // Tenant-Plan in DB aktualisieren
  await db.query(
    `UPDATE tenants
     SET plan = $1,
         subscription_id = $2,
         subscription_status = $3,
         updated_at = NOW()
     WHERE id = $4`,
    [newPlan, subscription.id, subscription.status, tenant.id]
  );

  // Feature-Flags aus Plan-Limits setzen
  await db.query(
    `UPDATE tenants
     SET settings = settings || $1::jsonb
     WHERE id = $2`,
    [
      JSON.stringify({
        max_workflows: planConfig.limits.max_workflows,
        max_gateways: planConfig.limits.max_gateways,
        max_agent_runs_per_month: planConfig.limits.max_agent_runs_per_month,
        compliance_reports: planConfig.limits.compliance_reports,
        human_approval: planConfig.limits.human_approval,
        allowed_agent_types: planConfig.limits.allowed_agent_types,
      }),
      tenant.id,
    ]
  );

  // Welcome-Mail senden
  const users = await db.query(
    "SELECT email, display_name FROM users WHERE tenant_id = $1 AND role = 'owner' LIMIT 1",
    [tenant.id]
  );
  if (users.rows.length > 0) {
    const owner = users.rows[0];
    await sendEmail(
      owner.email,
      `Willkommen beim RealSyncDynamics ${planConfig.name}-Plan!`,
      `<h1>Danke, ${owner.display_name}!</h1>
       <p>Deine Subscription für den <strong>${planConfig.name}-Plan</strong> ist aktiv.</p>
       <p>Du kannst jetzt bis zu ${planConfig.limits.max_workflows === -1 ? 'unbegrenzt viele' : planConfig.limits.max_workflows} Workflows und
       ${planConfig.limits.max_agent_runs_per_month === -1 ? 'unbegrenzt viele' : planConfig.limits.max_agent_runs_per_month} Agent-Runs pro Monat nutzen.</p>
       <p><a href="${process.env.APP_FRONTEND_URL}/dashboard">Zum Dashboard</a></p>`
    );
  }

  await writeAuditLog(
    tenant.id,
    'subscription.created',
    { subscription_id: subscription.id, plan: newPlan, status: subscription.status },
    event.id
  );

  console.log(`[Webhook] subscription.created: Tenant ${tenant.id} → Plan ${newPlan}`);
}

/**
 * customer.subscription.updated
 * Plan und Feature-Flags aktualisieren bei Plan-Wechsel oder Status-Änderung.
 */
async function handleSubscriptionUpdated(event) {
  const subscription = event.data.object;
  const tenant = await getTenantByCustomerId(subscription.customer);

  if (!tenant) {
    console.warn('[Webhook] subscription.updated: Kein Tenant für Customer', subscription.customer);
    return;
  }

  const priceId = subscription.items?.data?.[0]?.price?.id;
  const newPlan = getPlanByStripePriceId(priceId) || tenant.plan;
  const planConfig = PLANS[newPlan];

  await db.query(
    `UPDATE tenants
     SET plan = $1,
         subscription_id = $2,
         subscription_status = $3,
         updated_at = NOW()
     WHERE id = $4`,
    [newPlan, subscription.id, subscription.status, tenant.id]
  );

  // Feature-Flags aktualisieren
  await db.query(
    `UPDATE tenants
     SET settings = settings || $1::jsonb
     WHERE id = $2`,
    [
      JSON.stringify({
        max_workflows: planConfig.limits.max_workflows,
        max_gateways: planConfig.limits.max_gateways,
        max_agent_runs_per_month: planConfig.limits.max_agent_runs_per_month,
        compliance_reports: planConfig.limits.compliance_reports,
        human_approval: planConfig.limits.human_approval,
        allowed_agent_types: planConfig.limits.allowed_agent_types,
      }),
      tenant.id,
    ]
  );

  await writeAuditLog(
    tenant.id,
    'subscription.updated',
    {
      subscription_id: subscription.id,
      plan: newPlan,
      status: subscription.status,
      cancel_at_period_end: subscription.cancel_at_period_end,
    },
    event.id
  );

  console.log(`[Webhook] subscription.updated: Tenant ${tenant.id} → Plan ${newPlan}, Status ${subscription.status}`);
}

/**
 * customer.subscription.deleted
 * Tenant auf Free-Plan downgraden.
 */
async function handleSubscriptionDeleted(event) {
  const subscription = event.data.object;
  const tenant = await getTenantByCustomerId(subscription.customer);

  if (!tenant) {
    console.warn('[Webhook] subscription.deleted: Kein Tenant für Customer', subscription.customer);
    return;
  }

  const freePlan = PLANS.free;

  await db.query(
    `UPDATE tenants
     SET plan = 'free',
         subscription_id = NULL,
         subscription_status = 'canceled',
         settings = settings || $1::jsonb,
         updated_at = NOW()
     WHERE id = $2`,
    [
      JSON.stringify({
        max_workflows: freePlan.limits.max_workflows,
        max_gateways: freePlan.limits.max_gateways,
        max_agent_runs_per_month: freePlan.limits.max_agent_runs_per_month,
        compliance_reports: freePlan.limits.compliance_reports,
        human_approval: freePlan.limits.human_approval,
        allowed_agent_types: freePlan.limits.allowed_agent_types,
      }),
      tenant.id,
    ]
  );

  // Benachrichtigungs-Mail an Tenant-Owner
  const users = await db.query(
    "SELECT email, display_name FROM users WHERE tenant_id = $1 AND role = 'owner' LIMIT 1",
    [tenant.id]
  );
  if (users.rows.length > 0) {
    const owner = users.rows[0];
    await sendEmail(
      owner.email,
      'Deine RealSyncDynamics Subscription wurde beendet',
      `<p>Hallo ${owner.display_name},</p>
       <p>deine Subscription wurde beendet. Du hast jetzt Zugriff auf den kostenlosen Free-Plan.</p>
       <p><a href="${process.env.APP_FRONTEND_URL}/billing/upgrade">Jetzt wieder upgraden</a></p>`
    );
  }

  await writeAuditLog(
    tenant.id,
    'subscription.deleted',
    { subscription_id: subscription.id, downgraded_to: 'free' },
    event.id
  );

  console.log(`[Webhook] subscription.deleted: Tenant ${tenant.id} → Free`);
}

/**
 * invoice.payment_succeeded
 * Zahlungsbestätigung loggen.
 */
async function handleInvoicePaymentSucceeded(event) {
  const invoice = event.data.object;
  const tenant = await getTenantByCustomerId(invoice.customer);

  if (!tenant) return;

  await writeAuditLog(
    tenant.id,
    'invoice.payment_succeeded',
    {
      invoice_id: invoice.id,
      amount_paid: invoice.amount_paid / 100,
      currency: invoice.currency,
      invoice_url: invoice.hosted_invoice_url,
    },
    event.id
  );

  // Optional: Subscription-Status sicherstellen
  if (invoice.subscription) {
    await db.query(
      "UPDATE tenants SET subscription_status = 'active' WHERE id = $1",
      [tenant.id]
    );
  }

  console.log(`[Webhook] invoice.payment_succeeded: Tenant ${tenant.id}, Betrag ${invoice.amount_paid / 100} ${invoice.currency}`);
}

/**
 * invoice.payment_failed
 * Admin benachrichtigen, Tenant-Status auf 'past_due' setzen.
 */
async function handleInvoicePaymentFailed(event) {
  const invoice = event.data.object;
  const tenant = await getTenantByCustomerId(invoice.customer);

  if (!tenant) return;

  // Tenant-Status aktualisieren
  await db.query(
    "UPDATE tenants SET subscription_status = 'past_due', updated_at = NOW() WHERE id = $1",
    [tenant.id]
  );

  const adminEmails = await getAdminEmails();
  for (const adminEmail of adminEmails) {
    await sendEmail(
      adminEmail,
      `[ALERT] Zahlungsfehler: Tenant ${tenant.name}`,
      `<p>Zahlung fehlgeschlagen für Tenant <strong>${tenant.name}</strong> (ID: ${tenant.id}).</p>
       <p>Invoice: ${invoice.id} | Betrag: ${invoice.amount_due / 100} ${invoice.currency}</p>
       <p>Stripe Invoice: <a href="${invoice.hosted_invoice_url}">${invoice.hosted_invoice_url}</a></p>
       <p>Stripe wird automatisch erneut versuchen, die Zahlung einzuziehen.</p>`
    );
  }

  // Benachrichtigung an Tenant-Owner
  const users = await db.query(
    "SELECT email, display_name FROM users WHERE tenant_id = $1 AND role = 'owner' LIMIT 1",
    [tenant.id]
  );
  if (users.rows.length > 0) {
    const owner = users.rows[0];
    await sendEmail(
      owner.email,
      'Zahlungsproblem mit deiner RealSyncDynamics Subscription',
      `<p>Hallo ${owner.display_name},</p>
       <p>leider konnte deine Zahlung nicht verarbeitet werden.</p>
       <p>Bitte aktualisiere deine Zahlungsmethode: <a href="${invoice.hosted_invoice_url}">Rechnung anzeigen</a></p>`
    );
  }

  await writeAuditLog(
    tenant.id,
    'invoice.payment_failed',
    {
      invoice_id: invoice.id,
      amount_due: invoice.amount_due / 100,
      currency: invoice.currency,
      attempt_count: invoice.attempt_count,
    },
    event.id
  );

  console.log(`[Webhook] invoice.payment_failed: Tenant ${tenant.id}, Invoice ${invoice.id}`);
}

/**
 * checkout.session.completed
 * Tenant mit Stripe Customer verknüpfen (falls noch nicht geschehen).
 */
async function handleCheckoutSessionCompleted(event) {
  const session = event.data.object;
  const tenantId = session.metadata?.tenant_id;

  if (!tenantId) {
    console.warn('[Webhook] checkout.session.completed: Keine tenant_id in metadata');
    return;
  }

  // Stripe Customer ID zum Tenant speichern
  if (session.customer) {
    await db.query(
      `UPDATE tenants
       SET stripe_customer_id = $1, updated_at = NOW()
       WHERE id = $2 AND (stripe_customer_id IS NULL OR stripe_customer_id = '')`,
      [session.customer, tenantId]
    );
  }

  await writeAuditLog(
    tenantId,
    'checkout.session.completed',
    {
      session_id: session.id,
      customer_id: session.customer,
      plan: session.metadata?.plan,
      amount_total: session.amount_total ? session.amount_total / 100 : 0,
    },
    event.id
  );

  console.log(`[Webhook] checkout.session.completed: Tenant ${tenantId} → Customer ${session.customer}`);
}

// ---------------------------------------------------------------------------
// Hauptroute: POST / (Stripe sendet Events hierhin)
// ---------------------------------------------------------------------------
router.post(
  '/',
  express.raw({ type: 'application/json' }), // raw body für Signatur-Verifikation
  async (req, res) => {
    const signature = req.headers['stripe-signature'];

    if (!signature) {
      return res.status(400).json({ error: 'Fehlende Stripe-Signatur' });
    }

    let event;

    // Stripe-Signatur verifizieren
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('[Webhook] Signatur-Verifikation fehlgeschlagen:', err.message);
      return res.status(400).json({ error: `Webhook-Signatur ungültig: ${err.message}` });
    }

    // Idempotenz: Event bereits verarbeitet?
    if (processedEvents.has(event.id)) {
      console.log(`[Webhook] Duplikat ignoriert: ${event.id}`);
      return res.status(200).json({ received: true, duplicate: true });
    }

    // Event als verarbeitet markieren (vor der Verarbeitung um Race Conditions zu minimieren)
    processedEvents.add(event.id);

    // Set-Größe begrenzen (Memory Management)
    if (processedEvents.size > 10000) {
      const firstEntry = processedEvents.values().next().value;
      processedEvents.delete(firstEntry);
    }

    // Event verarbeiten
    try {
      switch (event.type) {
        case 'customer.subscription.created':
          await handleSubscriptionCreated(event);
          break;

        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(event);
          break;

        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(event);
          break;

        case 'invoice.payment_succeeded':
          await handleInvoicePaymentSucceeded(event);
          break;

        case 'invoice.payment_failed':
          await handleInvoicePaymentFailed(event);
          break;

        case 'checkout.session.completed':
          await handleCheckoutSessionCompleted(event);
          break;

        default:
          console.log(`[Webhook] Unbehandelter Event-Typ: ${event.type}`);
      }

      // Stripe erwartet 200 innerhalb von 30s
      return res.status(200).json({ received: true, event_type: event.type });
    } catch (err) {
      console.error(`[Webhook] Fehler bei ${event.type}:`, err);

      // Event aus processed Set entfernen damit Stripe retry funktioniert
      processedEvents.delete(event.id);

      return res.status(500).json({ error: 'Webhook-Verarbeitung fehlgeschlagen' });
    }
  }
);

module.exports = router;
