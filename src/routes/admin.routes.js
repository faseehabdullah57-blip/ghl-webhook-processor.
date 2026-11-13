const express = require('express');
const {
  verifyAdminApiKey,
  getDlqEvents,
  replayDlqEvents,
  handleGhlSync,
} = require('../controllers/admin.controller');

const router = express.Router();

/**
 * GET /api/v1/dlq
 * Protected by ADMIN_API_KEY (`x-admin-key`). Lists all failed events in the DLQ.
 */
router.get('/dlq', verifyAdminApiKey, getDlqEvents);

/**
 * POST /api/v1/dlq/replay
 * Protected by ADMIN_API_KEY (`x-admin-key`). Replays all failed events in the DLQ.
 */
router.post('/dlq/replay', verifyAdminApiKey, replayDlqEvents);

/**
 * POST /api/v1/ghl-sync
 * Protected by ADMIN_API_KEY (`x-admin-key`). Bi-directional write-back to GoHighLevel API v2.
 */
router.post('/ghl-sync', verifyAdminApiKey, handleGhlSync);

module.exports = router;

