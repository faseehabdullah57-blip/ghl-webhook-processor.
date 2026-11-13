const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  security: {
    webhookSecret: process.env.GHL_WEBHOOK_SECRET || 'default_dev_secret_change_in_prod',
    headerName: 'x-ghl-signature',
    adminApiKey: process.env.ADMIN_API_KEY || 'default_admin_secret_change_in_prod',
  },
  downstream: {
    url: process.env.DOWNSTREAM_API_URL || 'https://api.internal-crm.example.com/v1/leads',
    apiKey: process.env.DOWNSTREAM_API_KEY || 'sim_api_key',
    timeoutMs: parseInt(process.env.DOWNSTREAM_TIMEOUT_MS, 10) || 5000,
  },
  ghl: {
    baseUrl: process.env.GHL_API_BASE_URL || 'https://services.leadconnectorhq.com',
    apiToken: process.env.GHL_API_TOKEN || 'pit-your-private-integration-token',
    locationId: process.env.GHL_LOCATION_ID || 'your-sub-account-location-id',
    version: '2021-07-28',
  },
  alerts: {
    webhookUrl: process.env.ALERT_WEBHOOK_URL || '',
  },
  dlq: {
    filePath:
      process.env.DLQ_FILE_PATH || path.join(__dirname, '../../data/dlq_failed_events.json'),
  },
  retry: {
    maxAttempts: parseInt(process.env.MAX_RETRY_ATTEMPTS, 10) || 3,
    initialBackoffMs: parseInt(process.env.INITIAL_BACKOFF_MS, 10) || 500,
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
};

module.exports = config;
