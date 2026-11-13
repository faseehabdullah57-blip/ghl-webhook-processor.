/**
 * Sanitizes and normalizes contact fields and extracts dynamic custom fields
 * from raw GoHighLevel (GHL) webhook payloads.
 */

/**
 * Formats a raw phone string into E.164 standard (e.g., +14155552671).
 * Assumes US/North America (+1) country code if a 10-digit local number is provided without prefix.
 *
 * @param {string|number|null|undefined} rawPhone
 * @param {string} [defaultCountryCode='1']
 * @returns {string|null} Normalized E.164 phone number or null if invalid/empty.
 */
function normalizePhoneToE164(rawPhone, defaultCountryCode = '1') {
  if (rawPhone === null || rawPhone === undefined) return null;

  const str = String(rawPhone).trim();
  if (!str) return null;

  // Check if it already starts with '+'
  const hasPlus = str.startsWith('+');
  // Strip all non-digit characters
  const digits = str.replace(/\D/g, '');

  if (!digits || digits.length < 7 || digits.length > 15) {
    return null;
  }

  if (hasPlus) {
    return `+${digits}`;
  }

  // Handle standard 10-digit US/Canada numbers
  if (digits.length === 10) {
    return `+${defaultCountryCode}${digits}`;
  }

  // Handle 11-digit numbers starting with country code (e.g. 18005551234)
  if (digits.length === 11 && digits.startsWith(defaultCountryCode)) {
    return `+${digits}`;
  }

  // Fallback for international numbers passed without '+'
  return `+${digits}`;
}

/**
 * Normalizes an email address (trims whitespace, converts to lowercase, strips basic invalid chars).
 *
 * @param {string|null|undefined} rawEmail
 * @returns {string|null}
 */
function normalizeEmail(rawEmail) {
  if (!rawEmail || typeof rawEmail !== 'string') return null;

  const cleaned = rawEmail.trim().toLowerCase();
  if (!cleaned) return null;

  // Basic structural check for email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(cleaned) ? cleaned : null;
}

/**
 * Sanitizes plain text strings to strip control characters, HTML tags, and excessive whitespace.
 *
 * @param {string|null|undefined} input
 * @returns {string|null}
 */
function sanitizeString(input) {
  if (input === null || input === undefined) return null;
  const str = String(input)
    .replace(/<[^>]*>?/gm, '') // strip HTML tags
    .replace(/[\x00-\x1F\x7F]/g, '') // strip ASCII control chars
    .replace(/\s+/g, ' ')
    .trim();

  return str.length > 0 ? str : null;
}

/**
 * Extracts custom fields matching dynamic tags from a GHL payload.
 * GHL payloads may include tags (e.g. ["utm_source", "vip_tier", "custom:budget"])
 * and custom fields inside `customData`, `customFields`, or top-level keys.
 *
 * Rules:
 * 1. Normalizes tags into snake_case lookup keys (also supports "prefix:key" dynamic tags).
 * 2. Extracts matching keys from `payload.customData`, `payload.customFields` (array or object),
 *    or top-level payload properties.
 * 3. Includes any explicit `customData` fields alongside matched dynamic tag fields.
 *
 * @param {Object} payload - Raw GHL webhook payload
 * @returns {{ normalizedTags: string[], extractedCustomFields: Object }}
 */
function extractDynamicCustomFields(payload = {}) {
  const rawTags = Array.isArray(payload.tags)
    ? payload.tags
    : typeof payload.tags === 'string'
      ? payload.tags.split(',').map((t) => t.trim())
      : [];

  const normalizedTags = rawTags
    .map((t) => sanitizeString(t))
    .filter(Boolean)
    .map((t) => t.toLowerCase());

  // Build a consolidated lookup map of all candidate custom fields in the payload
  const customSourceMap = new Map();

  // 1. From payload.customData (Object)
  if (payload.customData && typeof payload.customData === 'object' && !Array.isArray(payload.customData)) {
    for (const [key, val] of Object.entries(payload.customData)) {
      customSourceMap.set(key.toLowerCase().trim(), { originalKey: key, value: val });
    }
  }

  // 2. From payload.customFields (Array of { id, key, field_value, value } or Object)
  if (Array.isArray(payload.customFields)) {
    for (const item of payload.customFields) {
      if (item && typeof item === 'object') {
        const fieldKey = item.key || item.fieldKey || item.name || item.id;
        const fieldVal = item.value !== undefined ? item.value : item.field_value;
        if (fieldKey) {
          const cleanKey = String(fieldKey).replace(/^contact\./i, '').trim();
          customSourceMap.set(cleanKey.toLowerCase(), { originalKey: cleanKey, value: fieldVal });
        }
      }
    }
  } else if (payload.customFields && typeof payload.customFields === 'object') {
    for (const [key, val] of Object.entries(payload.customFields)) {
      customSourceMap.set(key.toLowerCase().trim(), { originalKey: key, value: val });
    }
  }

  // 3. Also index non-standard top-level fields for dynamic tag extraction
  const reservedKeys = new Set([
    'id',
    'contact_id',
    'contactid',
    'first_name',
    'firstname',
    'last_name',
    'lastname',
    'full_name',
    'name',
    'email',
    'phone',
    'tags',
    'customdata',
    'customfields',
    'location',
    'locationid',
    'workflow',
  ]);

  for (const [key, val] of Object.entries(payload)) {
    const lowerKey = key.toLowerCase().trim();
    if (!reservedKeys.has(lowerKey) && !customSourceMap.has(lowerKey)) {
      customSourceMap.set(lowerKey, { originalKey: key, value: val });
    }
  }

  const extractedCustomFields = {};

  // Match dynamic tags against customSourceMap
  for (const tag of normalizedTags) {
    // Support tags formatted like "field:lead_score" or direct tag name "lead_score"
    const lookupKey = tag.includes(':') ? tag.split(':').slice(1).join(':').trim() : tag;
    const snakeKey = lookupKey.replace(/[\s-]+/g, '_');

    if (customSourceMap.has(lookupKey)) {
      const entry = customSourceMap.get(lookupKey);
      extractedCustomFields[entry.originalKey] =
        typeof entry.value === 'string' ? sanitizeString(entry.value) : entry.value;
    } else if (customSourceMap.has(snakeKey)) {
      const entry = customSourceMap.get(snakeKey);
      extractedCustomFields[entry.originalKey] =
        typeof entry.value === 'string' ? sanitizeString(entry.value) : entry.value;
    } else if (tag.includes(':')) {
      // Key-value dynamic tag (e.g., "tier:enterprise") where the value is embedded in the tag itself
      const [tagPrefix, tagValue] = tag.split(':').map((s) => s.trim());
      if (tagPrefix && tagValue && !(tagPrefix in extractedCustomFields)) {
        extractedCustomFields[tagPrefix] = tagValue;
      }
    }
  }

  // Also preserve all explicit `customData` entries even if not in tags
  if (payload.customData && typeof payload.customData === 'object' && !Array.isArray(payload.customData)) {
    for (const [key, val] of Object.entries(payload.customData)) {
      if (!(key in extractedCustomFields)) {
        extractedCustomFields[key] = typeof val === 'string' ? sanitizeString(val) : val;
      }
    }
  }

  return {
    normalizedTags,
    extractedCustomFields,
  };
}

/**
 * Normalizes a full GHL webhook payload into a clean, canonical contact structure.
 *
 * @param {Object} payload - Raw GHL webhook payload
 * @param {string} trackingId - Unique request tracking ID
 * @returns {Object} Normalized contact & metadata payload
 */
function transformGhlPayload(payload = {}, trackingId) {
  const contactId = sanitizeString(payload.contact_id || payload.contactId || payload.id) || 'unknown';
  const firstName = sanitizeString(payload.first_name || payload.firstName);
  const lastName = sanitizeString(payload.last_name || payload.lastName);
  const fullName =
    sanitizeString(payload.full_name || payload.fullName || payload.name) ||
    [firstName, lastName].filter(Boolean).join(' ') ||
    null;

  const email = normalizeEmail(payload.email);
  const phone = normalizePhoneToE164(payload.phone || payload.phoneRaw);
  const locationId = sanitizeString(
    payload.locationId || payload.location_id || (payload.location && payload.location.id)
  );

  const { normalizedTags, extractedCustomFields } = extractDynamicCustomFields(payload);

  return {
    trackingId,
    processedAt: new Date().toISOString(),
    source: 'GoHighLevel',
    locationId,
    contact: {
      contactId,
      firstName,
      lastName,
      fullName,
      email,
      phone,
      tags: normalizedTags,
    },
    customFields: extractedCustomFields,
  };
}

module.exports = {
  normalizePhoneToE164,
  normalizeEmail,
  sanitizeString,
  extractDynamicCustomFields,
  transformGhlPayload,
};
