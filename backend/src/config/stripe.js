/**
 * Stripe client configuration — lazy initialisation
 * RealSyncDynamics Agent-OS
 *
 * Lazy init prevents crash in test/CI environments where
 * STRIPE_SECRET_KEY is a placeholder or absent at module-load time.
 * The real Stripe instance is created on first use.
 */

'use strict';

const Stripe = require('stripe');

let _stripe = null;

function getStripe() {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_for_ci_only';
    _stripe = new Stripe(key, {
      apiVersion: '2024-06-20',
      appInfo: {
        name:    'RealSyncDynamics Agent-OS',
        version: '1.0.0',
      },
    });
  }
  return _stripe;
}

// Proxy object: allows `const stripe = require('../config/stripe')` and
// calling stripe.customers.create() etc. without changing call sites.
// The proxy intercepts property access and delegates to the lazy instance.
module.exports = new Proxy(
  {},
  {
    get(_target, prop) {
      return getStripe()[prop];
    },
    apply(_target, _thisArg, args) {
      return getStripe()(...args);
    },
  }
);
