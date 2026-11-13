const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Sends a formatted JSON POST alert notification to `process.env.ALERT_WEBHOOK_URL`
 * (compatible with both Slack `text` and Discord `content` webhook schemas)
 * whenever a webhook event exhausts retries and enters the Dead-Letter Queue.
 *
 * Fails gracefully without throwing if `ALERT_WEBHOOK_URL` is unset or unreachable.
 *
 * @param {Object} params
 * @param {string} params.trackingId
 * @param {string|Error} params.error
 * @param {string} [params.contactEmail]
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
async function sendFailureAlert({ trackingId, error, contactEmail }) {
  const webhookUrl = (process.env.ALERT_WEBHOOK_URL ?? config.alerts.webhookUrl ?? '').trim();

  if (!webhookUrl) {
    logger.debug('Skipping failure alert notification: ALERT_WEBHOOK_URL is not configured', {
      trackingId,
    });
    return { sent: false, reason: 'ALERT_WEBHOOK_URL_NOT_SET' };
  }

  const errorMessage = error instanceof Error ? error.message : String(error || 'Unknown error');
  const safeEmail = contactEmail || 'unknown';
  const alertMessage =
    `🚨 *[GHL Webhook DLQ Alert]* Event moved to Dead-Letter Queue\n` +
    `• *Tracking ID*: \`${trackingId}\`\n` +
    `• *Contact Email*: \`${safeEmail}\`\n` +
    `• *Error*: ${errorMessage}\n` +
    `• *Timestamp*: ${new Date().toISOString()}`;

  const alertPayload = {
    text: alertMessage, // Slack incoming webhook format
    content: alertMessage, // Discord incoming webhook format
    trackingId,
    error: errorMessage,
    contactEmail: safeEmail,
    timestamp: new Date().toISOString(),
  };

  try {
    await axios.post(webhookUrl, alertPayload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    });

    logger.info('Sent DLQ failure alert notification', {
      trackingId,
    });

    return { sent: true };
  } catch (alertErr) {
    logger.warn('Failed to deliver DLQ alert notification (non-fatal)', {
      trackingId,
      alertError: alertErr.message,
    });
    return { sent: false, reason: alertErr.message };
  }
}

module.exports = {
  sendFailureAlert,
};
