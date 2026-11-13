const express = require('express');
const { verifyWebhookSecret } = require('../middleware/auth.middleware');
const { handleGhlWebhook } = require('../controllers/webhook.controller');

const router = express.Router();

/**
 * POST /api/v1/ghl-webhook
 * Protected by custom header secret verification middleware.
 */
router.post('/ghl-webhook', verifyWebhookSecret, handleGhlWebhook);

module.exports = router;
