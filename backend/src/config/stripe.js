/**
 * Stripe client configuration
 * RealSyncDynamics Agent-OS
 */

const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
  appInfo: {
    name: 'RealSyncDynamics Agent-OS',
    version: '1.0.0',
  },
});

module.exports = stripe;
