'use strict';

/**
 * notification.service.js
 * RealSync Agent-OS — Shared notification helper
 *
 * Exports: { sendEmail, sendSlack, sendNotification }
 *
 * Environment variables consumed:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *   SLACK_WEBHOOK_URL  (fallback when webhook_url not supplied)
 */

const nodemailer = require('nodemailer');
const axios      = require('axios');
const fs         = require('fs');
const path       = require('path');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to an email template file.
 * Templates live at  <src-root>/templates/email/<name>.html
 */
function templatePath(name) {
  return path.resolve(__dirname, '..', 'templates', 'email', `${name}.html`);
}

/**
 * Load an HTML template and replace all {{variable}} placeholders.
 * Returns the rendered string, or null if the file cannot be read.
 *
 * @param {string} name      - Template name (without .html extension)
 * @param {Object} variables - Map of placeholder → replacement value
 * @returns {string|null}
 */
function loadTemplate(name, variables = {}) {
  const filePath = templatePath(name);
  let html;

  try {
    html = fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return null;
  }

  // Replace every {{key}} with its value; unknown keys are left unchanged
  return html.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(variables, key)
      ? String(variables[key])
      : match
  );
}

/**
 * Build a nodemailer transporter from environment variables.
 * Called lazily so tests can override env vars before first use.
 */
function createTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'localhost',
    port:   Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth:   process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS || '',
        }
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// sendEmail
// ---------------------------------------------------------------------------

/**
 * Send an HTML email via SMTP.
 *
 * @param {Object} options
 * @param {string}  options.to          - Recipient address (or comma-separated list)
 * @param {string}  options.subject     - Email subject line
 * @param {string}  options.template    - Template name (e.g. 'welcome')
 * @param {Object}  [options.variables] - Template variable substitutions
 * @param {string}  [options.tenant_id] - Tenant identifier (used for logging)
 *
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendEmail(options = {}) {
  const { to, subject, template, variables = {}, tenant_id } = options;

  try {
    // Render HTML template; fall back to plain-text summary if missing
    const html = loadTemplate(template, variables);

    const mailOptions = {
      from:    process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@realsyncdynamics.com',
      to,
      subject,
    };

    if (html) {
      mailOptions.html = html;
      // Simple text fallback: strip tags
      mailOptions.text = html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
    } else {
      // Template not found — send minimal plain-text email
      mailOptions.text = [
        `Subject: ${subject}`,
        tenant_id ? `Tenant: ${tenant_id}` : '',
        '',
        `Template "${template}" could not be loaded. Please contact support.`,
      ]
        .filter(Boolean)
        .join('\n');

      console.warn(
        `[notification.service] Template "${template}" not found at ${templatePath(template)}. Falling back to plain text.`
      );
    }

    const transporter = createTransporter();
    const info = await transporter.sendMail(mailOptions);

    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[notification.service] sendEmail error:', err.message);
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// sendSlack
// ---------------------------------------------------------------------------

/**
 * Post a message to a Slack incoming webhook.
 *
 * @param {Object} options
 * @param {string}  [options.webhook_url] - Slack webhook URL (overrides env var)
 * @param {string}  [options.channel]     - Channel override (only respected by some webhook types)
 * @param {string}  [options.message]     - Plain-text message (used as fallback text)
 * @param {Array}   [options.blocks]      - Slack Block Kit blocks
 *
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendSlack(options = {}) {
  const { webhook_url, channel, message, blocks } = options;

  const url = webhook_url || process.env.SLACK_WEBHOOK_URL;

  if (!url) {
    const error = 'No Slack webhook URL provided and SLACK_WEBHOOK_URL is not set.';
    console.error('[notification.service] sendSlack error:', error);
    return { success: false, error };
  }

  const payload = {};
  if (channel)  payload.channel   = channel;
  if (message)  payload.text      = message;
  if (blocks && blocks.length > 0) payload.blocks = blocks;

  // Slack requires at least `text` or `blocks`
  if (!payload.text && !payload.blocks) {
    payload.text = '(no message content)';
  }

  try {
    await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000,
    });

    return { success: true };
  } catch (err) {
    const error =
      err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;

    console.error('[notification.service] sendSlack error:', error);
    return { success: false, error };
  }
}

// ---------------------------------------------------------------------------
// sendNotification
// ---------------------------------------------------------------------------

/**
 * Fan-out notification across one or more channels in parallel.
 *
 * @param {Object}   options
 * @param {string[]} [options.channels=['email','slack']] - Which channels to use
 * @param {Object}   [options.email]                      - Passed directly to sendEmail()
 * @param {Object}   [options.slack]                      - Passed directly to sendSlack()
 * @param {string}   [options.tenant_id]                  - Forwarded to sendEmail()
 *
 * @returns {Promise<{email?: Object, slack?: Object}>}
 */
async function sendNotification(options = {}) {
  const { channels = ['email', 'slack'], email = {}, slack = {}, tenant_id } = options;

  const tasks = {};

  if (channels.includes('email')) {
    tasks.email = sendEmail({ ...email, tenant_id });
  }

  if (channels.includes('slack')) {
    tasks.slack = sendSlack(slack);
  }

  // Resolve all in parallel
  const keys   = Object.keys(tasks);
  const values = await Promise.all(Object.values(tasks));

  const result = {};
  keys.forEach((key, i) => {
    result[key] = values[i];
  });

  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { sendEmail, sendSlack, sendNotification };
