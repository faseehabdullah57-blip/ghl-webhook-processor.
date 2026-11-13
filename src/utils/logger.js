const winston = require('winston');
const config = require('../config');

const { combine, timestamp, json, errors, colorize, printf } = winston.format;

const SENSITIVE_KEYS = new Set([
  'authorization',
  'x-ghl-signature',
  'x-highlevel-signature',
  'x-webhook-secret',
  'downstream_api_key',
  'apikey',
  'webhooksecret',
  'password',
  'secret',
  'token',
]);

const PII_KEYS = new Set([
  'email',
  'normalizedemail',
  'phone',
  'normalizedphone',
  'phoneraw',
]);

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const E164_PHONE_REGEX = /(?<![\w-])\+[1-9]\d{6,14}(?![\w-])/g;
const FORMATTED_PHONE_REGEX =
  /(?<![\w.-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b)(?![\w.-])/g;
const BEARER_REGEX = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Masks sensitive credentials, API keys, and raw email/phone PII inside strings.
 *
 * @param {string} str
 * @returns {string}
 */
function redactString(str) {
  if (typeof str !== 'string' || !str) return str;

  let result = str
    .replace(BEARER_REGEX, 'Bearer [REDACTED]')
    .replace(EMAIL_REGEX, '[REDACTED_EMAIL]')
    .replace(E164_PHONE_REGEX, '[REDACTED_PHONE]')
    .replace(FORMATTED_PHONE_REGEX, '[REDACTED_PHONE]');

  const activeSecrets = [config.downstream?.apiKey, config.security?.webhookSecret].filter(
    (s) => typeof s === 'string' && s.length >= 6
  );

  for (const secretVal of activeSecrets) {
    if (result.includes(secretVal)) {
      result = result.split(secretVal).join('[REDACTED]');
    }
  }

  return result;
}

/**
 * Recursively clones and redacts sensitive headers, secrets, and PII from log metadata.
 *
 * @param {*} value
 * @param {string} [keyName]
 * @param {WeakSet} [seen]
 * @returns {*}
 */
function redactSensitiveData(value, keyName = '', seen = new WeakSet()) {
  const lowerKey = String(keyName).toLowerCase();

  if (SENSITIVE_KEYS.has(lowerKey)) {
    return '[REDACTED]';
  }

  if (PII_KEYS.has(lowerKey) && value !== null && value !== undefined) {
    return lowerKey.includes('email') ? '[REDACTED_EMAIL]' : '[REDACTED_PHONE]';
  }

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, '', seen));
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);

    const copy = {};
    for (const [k, v] of Object.entries(value)) {
      copy[k] = redactSensitiveData(v, k, seen);
    }
    // Preserve symbol properties used internally by Winston (e.g., Symbol(level), Symbol(splat))
    for (const sym of Object.getOwnPropertySymbols(value)) {
      copy[sym] = value[sym];
    }
    return copy;
  }

  return value;
}

/**
 * Winston format filter that masks credentials (`authorization`, `x-ghl-signature`,
 * `x-webhook-secret`, `DOWNSTREAM_API_KEY`) and PII (emails, phone numbers).
 */
const redactSensitiveFormat = winston.format((info) => redactSensitiveData(info));

const consoleFormat = printf(({ level, message, timestamp: ts, trackingId, ...meta }) => {
  const trackingPrefix = trackingId ? `[trackingId=${trackingId}] ` : '';
  const metaString = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} ${level}: ${trackingPrefix}${message}${metaString}`;
});

const logger = winston.createLogger({
  level: config.logging.level,
  defaultMeta: { service: 'ghl-webhook-processor', env: config.env },
  format: combine(
    errors({ stack: true }),
    redactSensitiveFormat(),
    timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    json()
  ),
  transports: [
    new winston.transports.Console({
      silent: config.env === 'test',
      format:
        config.env === 'development'
          ? combine(
              redactSensitiveFormat(),
              colorize(),
              timestamp({ format: 'HH:mm:ss.SSS' }),
              consoleFormat
            )
          : combine(redactSensitiveFormat(), timestamp(), json()),
    }),
  ],
});

logger.redactSensitiveData = redactSensitiveData;
logger.redactString = redactString;

module.exports = logger;
