const crypto = require('crypto');
const logger = require('../utils/logger');
const { processWebhookPayload } = require('../services/webhookProcessor.service');

/**
 * Handles POST /api/v1/ghl-webhook requests.
 * Validates basic payload structure, generates a tracking ID, immediately responds
 * with HTTP 200 OK to prevent GoHighLevel webhook timeouts, and triggers
 * non-blocking in-memory processing.
 */
function handleGhlWebhook(req, res) {
  const payload = req.body;

  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length === 0) {
    logger.warn('Received empty or malformed GHL webhook payload', {
      ip: req.ip,
    });
    return res.status(400).json({
      status: 'error',
      message: 'Invalid or empty webhook payload.',
    });
  }

  const trackingId = crypto.randomUUID();

  logger.info('Inbound GHL webhook received and acknowledged', {
    trackingId,
    contactId: payload.contact_id || payload.contactId || payload.id || 'unidentified',
    eventType: payload.type || payload.event || 'contact.webhook',
  });

  // 1. Immediately acknowledge receipt to prevent GHL webhook timeout
  res.status(200).json({
    status: 'accepted',
    message: 'Webhook received and queued for asynchronous processing.',
    trackingId,
    timestamp: new Date().toISOString(),
  });

  // 2. Offload payload to in-memory asynchronous processing pipeline
  setImmediate(() => {
    processWebhookPayload(payload, trackingId).catch((err) => {
      logger.error('Unhandled exception in background webhook processor', {
        trackingId,
        error: err.message,
      });
    });
  });
}

module.exports = {
  handleGhlWebhook,
};
