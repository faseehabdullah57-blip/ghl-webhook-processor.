const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { transformGhlPayload } = require('../utils/sanitizer');
const dlqService = require('./dlq.service');
const alertService = require('./alert.service');

/**
 * Helper utility to pause execution for exponential backoff.
 *
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Forwards the normalized payload to the secondary REST endpoint via axios
 * with a configurable retry strategy and exponential backoff (base * 2^(attempt - 1)).
 *
 * @param {Object} structuredPayload - Canonical contact & customFields payload
 * @param {Object} [options] - Optional overrides for retry attempts and backoff
 * @returns {Promise<Object>} Downstream HTTP response data
 */
async function forwardToDownstreamWithRetry(structuredPayload, options = {}) {
  const maxAttempts = options.maxAttempts ?? config.retry.maxAttempts;
  const initialBackoffMs = options.initialBackoffMs ?? config.retry.initialBackoffMs;
  const targetUrl = options.targetUrl ?? config.downstream.url;
  const { trackingId } = structuredPayload;

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      logger.info(`Forwarding payload to downstream endpoint (Attempt ${attempt}/${maxAttempts})`, {
        trackingId,
        attempt,
        maxAttempts,
        targetUrl,
      });

      const response = await axios.post(targetUrl, structuredPayload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Tracking-Id': trackingId,
          Authorization: `Bearer ${config.downstream.apiKey}`,
        },
        timeout: config.downstream.timeoutMs,
      });

      logger.info('Successfully forwarded payload to downstream endpoint', {
        trackingId,
        attempt,
        statusCode: response.status,
      });

      return response.data;
    } catch (error) {
      lastError = error;
      const statusCode = error.response ? error.response.status : null;

      logger.warn(`Downstream forwarding attempt ${attempt} failed`, {
        trackingId,
        attempt,
        maxAttempts,
        statusCode,
        errorMessage: error.message,
      });

      if (attempt < maxAttempts) {
        const backoffDelay = initialBackoffMs * Math.pow(2, attempt - 1);
        logger.info(`Scheduling retry in ${backoffDelay}ms`, {
          trackingId,
          nextAttempt: attempt + 1,
          backoffDelayMs: backoffDelay,
        });
        // eslint-disable-next-line no-await-in-loop
        await sleep(backoffDelay);
      }
    }
  }

  logger.error('Exhausted all retry attempts forwarding payload to downstream endpoint', {
    trackingId,
    maxAttempts,
    finalError: lastError ? lastError.message : 'Unknown error',
  });

  throw lastError;
}

/**
 * In-memory asynchronous processor invoked after Express returns 200 OK.
 * Sanitizes/normalizes contact fields, extracts dynamic custom fields, and
 * forwards the structured payload to the secondary REST endpoint.
 * If all retries fail, persists the event to the Dead-Letter Queue (DLQ)
 * and dispatches a failure alert so zero leads are ever lost.
 *
 * @param {Object} rawPayload - Raw GoHighLevel webhook body
 * @param {string} trackingId - Generated correlation ID
 * @param {Object} [options] - Optional configuration overrides
 * @returns {Promise<{ structuredPayload?: Object, downstreamResponse?: Object|null, dlqEntry?: Object, success: boolean, error?: string }>}
 */
async function processWebhookPayload(rawPayload, trackingId, options = {}) {
  let structuredPayload = null;
  const maxAttempts = options.maxAttempts ?? config.retry.maxAttempts;

  try {
    logger.info('Starting asynchronous in-memory processing for GHL payload', {
      trackingId,
    });

    structuredPayload = transformGhlPayload(rawPayload, trackingId);

    logger.info('Sanitized and normalized GHL contact payload', {
      trackingId,
      contactId: structuredPayload.contact.contactId,
      normalizedEmail: structuredPayload.contact.email,
      normalizedPhone: structuredPayload.contact.phone,
      extractedCustomFieldKeys: Object.keys(structuredPayload.customFields),
    });

    const downstreamResponse = await forwardToDownstreamWithRetry(structuredPayload, options);

    logger.info('Completed asynchronous GHL webhook processing pipeline', {
      trackingId,
      status: 'SUCCESS',
    });

    return {
      success: true,
      structuredPayload,
      downstreamResponse,
    };
  } catch (error) {
    logger.error('Asynchronous GHL webhook processing pipeline failed', {
      trackingId,
      status: 'FAILED',
      errorMessage: error.message,
    });

    const payloadToStore = structuredPayload || rawPayload;
    const contactEmail =
      structuredPayload?.contact?.email || rawPayload?.email || 'unknown';

    let dlqEntry = null;
    try {
      dlqEntry = await dlqService.enqueueFailedEvent({
        trackingId,
        payload: payloadToStore,
        headers: options.headers || {},
        error: error.message,
        attempts: maxAttempts,
      });
    } catch (dlqErr) {
      logger.error('Failed to persist exhausted webhook event to DLQ', {
        trackingId,
        dlqError: dlqErr.message,
      });
    }

    await alertService.sendFailureAlert({
      trackingId,
      error: error.message,
      contactEmail,
    });

    return {
      success: false,
      error: error.message,
      dlqEntry,
    };
  }
}

module.exports = {
  sleep,
  forwardToDownstreamWithRetry,
  processWebhookPayload,
};
