const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Performs a constant-time comparison between two strings to prevent timing side-channel attacks.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Computes an HMAC-SHA256 hex digest for the given raw body and secret.
 *
 * @param {Buffer|string} rawBody
 * @param {string} [secret]
 * @returns {string}
 */
function computeHmacSignature(rawBody, secret = config.security.webhookSecret) {
  const bodyBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {}), 'utf8');
  return crypto.createHmac('sha256', secret).update(bodyBuffer).digest('hex');
}

/**
 * Parses `x-webhook-timestamp` header (supports Unix ms, Unix seconds, or ISO-8601 strings).
 *
 * @param {string|number} rawTimestamp
 * @returns {number} Timestamp in milliseconds or NaN if invalid
 */
function parseWebhookTimestamp(rawTimestamp) {
  const str = String(rawTimestamp).trim();
  if (!str) return NaN;

  if (/^\d+$/.test(str)) {
    const num = Number(str);
    // Treat 10-digit (or fewer) numeric timestamps as Unix seconds
    return str.length <= 10 ? num * 1000 : num;
  }

  return Date.parse(str);
}

/**
 * Express middleware that verifies webhook authenticity and freshness:
 * 1. Enforces replay protection if `x-webhook-timestamp` is present (rejects > 5 min old/skewed).
 * 2. Supports cryptographic HMAC-SHA256 verification (`x-highlevel-signature` / `x-ghl-signature`)
 *    computed against `req.rawBody` using `crypto.timingSafeEqual`.
 * 3. Supports standard shared-secret header checks (`x-webhook-secret` / `Authorization: Bearer`).
 */
function verifyWebhookSecret(req, res, next) {
  const expectedSecret = config.security.webhookSecret;

  // 1. Timestamp freshness check (Replay attack protection)
  const rawTimestamp = req.headers['x-webhook-timestamp'];
  if (rawTimestamp !== undefined) {
    const timestampMs = parseWebhookTimestamp(rawTimestamp);
    const nowMs = Date.now();

    if (Number.isNaN(timestampMs) || Math.abs(nowMs - timestampMs) > MAX_TIMESTAMP_DRIFT_MS) {
      logger.warn('Rejected GHL webhook: Expired or invalid webhook timestamp', {
        ip: req.ip,
        path: req.originalUrl,
        timestampHeader: rawTimestamp,
      });
      return res.status(401).json({
        status: 'error',
        message: 'Unauthorized: Webhook timestamp is expired or invalid.',
      });
    }
  }

  // 2. Extract signature or shared-secret headers
  const hmacHeader = req.headers['x-highlevel-signature'] || req.headers['x-ghl-signature'];
  const sharedSecretHeader =
    req.headers['x-webhook-secret'] ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7).trim()
      : null);

  if (
    (!hmacHeader || typeof hmacHeader !== 'string') &&
    (!sharedSecretHeader || typeof sharedSecretHeader !== 'string')
  ) {
    logger.warn('Rejected GHL webhook: Missing authentication secret or signature header', {
      ip: req.ip,
      path: req.originalUrl,
    });
    return res.status(401).json({
      status: 'error',
      message: 'Unauthorized: Missing webhook signature or secret token in headers.',
    });
  }

  let isAuthenticated = false;

  // 3. Check HMAC-SHA256 signature (and fallback shared-secret on x-ghl-signature)
  if (hmacHeader && typeof hmacHeader === 'string') {
    const cleanSignature = hmacHeader.replace(/^sha256=/i, '').trim();
    const rawBody =
      req.rawBody !== undefined
        ? req.rawBody
        : Buffer.from(JSON.stringify(req.body || {}), 'utf8');

    const expectedHmacHex = computeHmacSignature(rawBody, expectedSecret);
    const expectedHmacBase64 = crypto
      .createHmac('sha256', expectedSecret)
      .update(rawBody)
      .digest('base64');

    const isHmacMatch =
      timingSafeCompare(cleanSignature.toLowerCase(), expectedHmacHex.toLowerCase()) ||
      timingSafeCompare(cleanSignature, expectedHmacBase64);

    // Also allow shared-secret comparison for backward-compatible header usage
    const isDirectSecretMatch = timingSafeCompare(cleanSignature, expectedSecret);

    isAuthenticated = isHmacMatch || isDirectSecretMatch;
  }

  // 4. Check shared-secret headers (`x-webhook-secret` / `Authorization: Bearer`)
  if (!isAuthenticated && sharedSecretHeader && typeof sharedSecretHeader === 'string') {
    isAuthenticated = timingSafeCompare(sharedSecretHeader.trim(), expectedSecret);
  }

  if (!isAuthenticated) {
    logger.warn('Rejected GHL webhook: Invalid webhook signature or secret token', {
      ip: req.ip,
      path: req.originalUrl,
    });
    return res.status(403).json({
      status: 'error',
      message: 'Forbidden: Invalid webhook signature or secret token.',
    });
  }

  return next();
}

module.exports = {
  verifyWebhookSecret,
  computeHmacSignature,
  timingSafeCompare,
};
