const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { normalizeEmail, normalizePhoneToE164, sanitizeString } = require('../utils/sanitizer');

const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_API_VERSION = '2021-07-28';

/**
 * Builds standard GoHighLevel API v2 request headers.
 *
 * @returns {Object}
 */
function getGhlHeaders() {
  const token = process.env.GHL_API_TOKEN || config.ghl.apiToken;
  return {
    Authorization: `Bearer ${token}`,
    Version: GHL_API_VERSION,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/**
 * Creates a pre-configured Axios client for GoHighLevel API v2 (`https://services.leadconnectorhq.com`).
 * Falls back gracefully to top-level `axios` when `axios.create` is mocked in unit tests.
 */
const ghlClient =
  typeof axios.create === 'function'
    ? axios.create({
        baseURL: GHL_BASE_URL,
        headers: {
          Authorization: `Bearer ${process.env.GHL_API_TOKEN || config.ghl.apiToken}`,
          Version: GHL_API_VERSION,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 10000,
      })
    : null;

/**
 * Internal helper to execute a POST request against GoHighLevel API v2.
 *
 * @param {string} endpointPath
 * @param {Object} body
 * @returns {Promise<Object>}
 */
async function postToGhl(endpointPath, body) {
  const headers = getGhlHeaders();

  if (ghlClient && typeof ghlClient.post === 'function') {
    const response = await ghlClient.post(endpointPath, body, { headers });
    return response.data;
  }

  const response = await axios.post(`${GHL_BASE_URL}${endpointPath}`, body, {
    headers,
    timeout: 10000,
  });
  return response.data;
}

/**
 * Upserts a contact back into GoHighLevel via API v2 (`POST /contacts/upsert`).
 *
 * @param {Object} contactData
 * @param {string} [contactData.email]
 * @param {string} [contactData.phone]
 * @param {string} [contactData.firstName]
 * @param {string} [contactData.lastName]
 * @param {string[]} [contactData.tags]
 * @param {Array|Object} [contactData.customFields]
 * @param {string} [contactData.locationId]
 * @returns {Promise<Object>} GHL API response payload
 */
async function syncContactToGHL({
  email,
  phone,
  firstName,
  lastName,
  tags,
  customFields,
  locationId,
} = {}) {
  const resolvedLocationId =
    locationId || process.env.GHL_LOCATION_ID || config.ghl.locationId;

  const upsertPayload = {
    locationId: resolvedLocationId,
    email: normalizeEmail(email) || email,
    phone: normalizePhoneToE164(phone) || phone,
    firstName: sanitizeString(firstName),
    lastName: sanitizeString(lastName),
  };

  if (Array.isArray(tags)) {
    upsertPayload.tags = tags;
  }

  if (customFields !== undefined) {
    upsertPayload.customFields = customFields;
  }

  logger.info('Syncing contact to GoHighLevel via POST /contacts/upsert', {
    locationId: resolvedLocationId,
  });

  return postToGhl('/contacts/upsert', upsertPayload);
}

/**
 * Upserts or updates an opportunity stage/status in GoHighLevel (`POST /opportunities/upsert`).
 *
 * @param {Object} opportunityData
 * @param {string} [opportunityData.opportunityId]
 * @param {string} opportunityData.pipelineId
 * @param {string} opportunityData.pipelineStageId
 * @param {string} [opportunityData.status]
 * @param {number} [opportunityData.monetaryValue]
 * @param {string} [opportunityData.contactId]
 * @param {string} [opportunityData.locationId]
 * @returns {Promise<Object>} GHL API response payload
 */
async function updateOpportunityStage({
  opportunityId,
  pipelineId,
  pipelineStageId,
  status = 'open',
  monetaryValue,
  contactId,
  locationId,
} = {}) {
  const resolvedLocationId =
    locationId || process.env.GHL_LOCATION_ID || config.ghl.locationId;

  const upsertPayload = {
    locationId: resolvedLocationId,
    pipelineId,
    pipelineStageId,
    status,
  };

  if (opportunityId) {
    upsertPayload.id = opportunityId;
    upsertPayload.opportunityId = opportunityId;
  }
  if (contactId) {
    upsertPayload.contactId = contactId;
  }
  if (monetaryValue !== undefined) {
    upsertPayload.monetaryValue = Number(monetaryValue);
  }

  logger.info('Updating opportunity stage in GoHighLevel via POST /opportunities/upsert', {
    locationId: resolvedLocationId,
    pipelineId,
    pipelineStageId,
    status,
  });

  return postToGhl('/opportunities/upsert', upsertPayload);
}

module.exports = {
  GHL_BASE_URL,
  GHL_API_VERSION,
  getGhlHeaders,
  syncContactToGHL,
  updateOpportunityStage,
};
