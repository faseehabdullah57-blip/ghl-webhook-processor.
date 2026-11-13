const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const dlqService = require('../services/dlq.service');
const ghlSyncService = require('../services/ghlSync.service');

/**
 * Middleware to protect admin endpoints using `x-admin-key` header and `crypto.timingSafeEqual`.
 */
function verifyAdminApiKey(req, res, next) {
  const expectedKey = process.env.ADMIN_API_KEY || config.security.adminApiKey;
  const providedKey =
    req.headers['x-admin-key'] ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7).trim()
      : null);

  if (!providedKey || typeof providedKey !== 'string') {
    logger.warn('Rejected admin request: Missing x-admin-key header', {
      ip: req.ip,
      path: req.originalUrl,
    });
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized: Missing x-admin-key header.',
    });
  }

  const providedBuf = Buffer.from(providedKey.trim(), 'utf8');
  const expectedBuf = Buffer.from(expectedKey, 'utf8');

  const isMatch =
    providedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(providedBuf, expectedBuf);

  if (!isMatch) {
    logger.warn('Rejected admin request: Invalid x-admin-key header', {
      ip: req.ip,
      path: req.originalUrl,
    });
    return res.status(403).json({
      status: 'error',
      message: 'Forbidden: Invalid admin API key.',
    });
  }

  return next();
}

/**
 * GET /api/v1/dlq
 * Returns count and list of failed webhook events in the Dead-Letter Queue.
 */
async function getDlqEvents(_req, res, next) {
  try {
    const events = await dlqService.listFailedEvents();
    return res.status(200).json({
      status: 'ok',
      count: events.length,
      events,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/dlq/replay
 * Triggers sequential replay of all events in the Dead-Letter Queue and returns summary.
 */
async function replayDlqEvents(_req, res, next) {
  try {
    const summary = await dlqService.replayAllEvents();
    return res.status(200).json({
      status: 'ok',
      ...summary,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/ghl-sync
 * Accepts inbound status updates from external systems (e.g., Stripe, ERP)
 * and writes contact/opportunity updates back to GoHighLevel API v2.
 */
async function handleGhlSync(req, res, next) {
  try {
    const body = req.body || {};

    if (Object.keys(body).length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid or empty sync payload.',
      });
    }

    let contactResult = null;
    let opportunityResult = null;

    const hasContactFields = Boolean(
      body.email || body.phone || body.firstName || body.lastName || body.contact
    );
    const hasOpportunityFields = Boolean(
      body.pipelineId || body.pipelineStageId || body.opportunityId || body.opportunity
    );

    if (hasContactFields) {
      const contactInput = body.contact ? { ...body.contact, locationId: body.locationId } : body;
      contactResult = await ghlSyncService.syncContactToGHL(contactInput);
    }

    if (hasOpportunityFields) {
      const oppInput = body.opportunity
        ? { ...body.opportunity, locationId: body.locationId }
        : body;
      opportunityResult = await ghlSyncService.updateOpportunityStage(oppInput);
    }

    return res.status(200).json({
      status: 'ok',
      synced: true,
      contactResult,
      opportunityResult,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  verifyAdminApiKey,
  getDlqEvents,
  replayDlqEvents,
  handleGhlSync,
};

