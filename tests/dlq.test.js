const path = require('path');
const fs = require('fs/promises');
const request = require('supertest');
const axios = require('axios');
const app = require('../src/app');
const config = require('../src/config');
const dlqService = require('../src/services/dlq.service');
const alertService = require('../src/services/alert.service');
const ghlSyncService = require('../src/services/ghlSync.service');
const { processWebhookPayload } = require('../src/services/webhookProcessor.service');

jest.mock('axios');

describe('Dead-Letter Queue (DLQ), Failure Alerts, Admin Replay & GHL Bi-Directional Sync', () => {
  const adminKey = config.security.adminApiKey;
  const testDlqPath = path.join(__dirname, '../data/dlq_failed_events.json');

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.DLQ_FILE_PATH = testDlqPath;
    delete process.env.ALERT_WEBHOOK_URL;
    await dlqService.clearFailedEvents();
    if (app.apiLimiter && typeof app.apiLimiter.resetKey === 'function') {
      app.apiLimiter.resetKey('::ffff:127.0.0.1');
      app.apiLimiter.resetKey('127.0.0.1');
    }
  });

  afterAll(async () => {
    try {
      await fs.unlink(testDlqPath);
    } catch {
      // ignore if already removed
    }
  });

  describe('DLQ Persistence & Automatic Failure Capture', () => {
    it('enqueues failed webhook events with ISO timestamps and lists them accurately', async () => {
      const entry = await dlqService.enqueueFailedEvent({
        trackingId: 'trk_dlq_101',
        payload: { contact_id: 'cnt_101', email: 'lead101@example.com' },
        headers: { 'x-ghl-signature': 'REDACTED' },
        error: 'ETIMEDOUT: Downstream CRM unreachable',
        attempts: 3,
      });

      expect(entry.id).toBe('dlq_trk_dlq_101');
      expect(entry.trackingId).toBe('trk_dlq_101');
      expect(entry.attempts).toBe(3);
      expect(new Date(entry.failedAt).toISOString()).toBe(entry.failedAt);

      const queued = await dlqService.listFailedEvents();
      expect(queued).toHaveLength(1);
      expect(queued[0].trackingId).toBe('trk_dlq_101');
    });

    it('automatically persists exhausted webhook events to DLQ and sends alerts when configured', async () => {
      process.env.ALERT_WEBHOOK_URL = 'https://hooks.slack.com/services/T00/B00/X00';
      axios.post
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
        .mockRejectedValueOnce(new Error('503 Service Unavailable'))
        .mockResolvedValueOnce({ status: 200, data: { ok: true } }); // Alert webhook POST

      const result = await processWebhookPayload(
        { contact_id: 'cnt_dlq_auto', email: 'auto@example.com' },
        'trk_auto_dlq',
        { maxAttempts: 2, initialBackoffMs: 5 }
      );

      expect(result.success).toBe(false);
      expect(result.dlqEntry).toBeDefined();
      expect(result.dlqEntry.trackingId).toBe('trk_auto_dlq');

      const queued = await dlqService.listFailedEvents();
      expect(queued).toHaveLength(1);
      expect(queued[0].trackingId).toBe('trk_auto_dlq');

      // 2 downstream attempts + 1 alert webhook call
      expect(axios.post).toHaveBeenCalledTimes(3);
      const [alertUrl, alertBody] = axios.post.mock.calls[2];
      expect(alertUrl).toBe('https://hooks.slack.com/services/T00/B00/X00');
      expect(alertBody.text).toContain('trk_auto_dlq');
      expect(alertBody.content).toContain('trk_auto_dlq');
    });

    it('fails gracefully without throwing when ALERT_WEBHOOK_URL is unset', async () => {
      delete process.env.ALERT_WEBHOOK_URL;
      const alertResult = await alertService.sendFailureAlert({
        trackingId: 'trk_no_alert',
        error: 'Downstream timeout',
        contactEmail: 'silent@example.com',
      });

      expect(alertResult.sent).toBe(false);
      expect(axios.post).not.toHaveBeenCalled();
    });
  });

  describe('Batch Replay Engine (replayAllEvents)', () => {
    it('replays all queued events sequentially, removes succeeded ones, and keeps failed ones', async () => {
      await dlqService.enqueueFailedEvent({
        trackingId: 'trk_replay_ok',
        payload: { trackingId: 'trk_replay_ok', contact: { contactId: 'c1' } },
        error: 'Initial timeout',
        attempts: 3,
      });
      await dlqService.enqueueFailedEvent({
        trackingId: 'trk_replay_fail',
        payload: { trackingId: 'trk_replay_fail', contact: { contactId: 'c2' } },
        error: 'Initial timeout',
        attempts: 3,
      });

      const mockForwarder = jest
        .fn()
        .mockResolvedValueOnce({ status: 'recovered' })
        .mockRejectedValueOnce(new Error('Still down'));

      const summary = await dlqService.replayAllEvents(mockForwarder);

      expect(summary).toEqual({
        replayed: 2,
        succeeded: 1,
        stillFailed: 1,
      });

      const remaining = await dlqService.listFailedEvents();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].trackingId).toBe('trk_replay_fail');
      expect(remaining[0].attempts).toBe(4);
    });
  });

  describe('Admin API Endpoints (/api/v1/dlq, /api/v1/dlq/replay, /api/v1/ghl-sync)', () => {
    it('rejects requests without x-admin-key (401) or with invalid x-admin-key (403)', async () => {
      const noHeaderRes = await request(app).get('/api/v1/dlq');
      expect(noHeaderRes.status).toBe(401);

      const badHeaderRes = await request(app)
        .get('/api/v1/dlq')
        .set('x-admin-key', 'wrong_admin_key');
      expect(badHeaderRes.status).toBe(403);
    });

    it('returns queued DLQ events on GET /api/v1/dlq and replays them on POST /api/v1/dlq/replay', async () => {
      await dlqService.enqueueFailedEvent({
        trackingId: 'trk_admin_1',
        payload: { trackingId: 'trk_admin_1', contact: { contactId: 'cnt_admin_1' } },
        error: '502 Bad Gateway',
        attempts: 3,
      });

      const listRes = await request(app)
        .get('/api/v1/dlq')
        .set('x-admin-key', adminKey);

      expect(listRes.status).toBe(200);
      expect(listRes.body.count).toBe(1);
      expect(listRes.body.events[0].trackingId).toBe('trk_admin_1');

      axios.post.mockResolvedValueOnce({ status: 200, data: { synced: true } });

      const replayRes = await request(app)
        .post('/api/v1/dlq/replay')
        .set('x-admin-key', adminKey);

      expect(replayRes.status).toBe(200);
      expect(replayRes.body).toEqual({
        status: 'ok',
        replayed: 1,
        succeeded: 1,
        stillFailed: 0,
      });

      const afterListRes = await request(app)
        .get('/api/v1/dlq')
        .set('x-admin-key', adminKey);
      expect(afterListRes.body.count).toBe(0);
    });

    it('writes contact and opportunity updates back to GoHighLevel via POST /api/v1/ghl-sync', async () => {
      axios.post
        .mockResolvedValueOnce({
          status: 200,
          data: { contact: { id: 'ghl_cnt_synced_1' } },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { opportunity: { id: 'ghl_opp_synced_1', status: 'won' } },
        });

      const syncPayload = {
        email: '  CLIENT@STRIPE.COM ',
        phone: '(415) 555-9090',
        firstName: 'Diana',
        lastName: 'Prince',
        tags: ['stripe_paid', 'enterprise_tier'],
        pipelineId: 'pipe_01',
        pipelineStageId: 'stage_closed_won',
        opportunityId: 'opp_99',
        status: 'won',
        monetaryValue: 4500,
      };

      const res = await request(app)
        .post('/api/v1/ghl-sync')
        .set('x-admin-key', adminKey)
        .send(syncPayload);

      expect(res.status).toBe(200);
      expect(res.body.synced).toBe(true);
      expect(res.body.contactResult).toEqual({ contact: { id: 'ghl_cnt_synced_1' } });
      expect(res.body.opportunityResult).toEqual({
        opportunity: { id: 'ghl_opp_synced_1', status: 'won' },
      });

      expect(axios.post).toHaveBeenCalledTimes(2);
      const [contactUrl, contactBody, contactCfg] = axios.post.mock.calls[0];
      expect(contactUrl).toBe(`${ghlSyncService.GHL_BASE_URL}/contacts/upsert`);
      expect(contactBody.email).toBe('client@stripe.com');
      expect(contactBody.phone).toBe('+14155559090');
      expect(contactCfg.headers.Version).toBe('2021-07-28');

      const [oppUrl, oppBody] = axios.post.mock.calls[1];
      expect(oppUrl).toBe(`${ghlSyncService.GHL_BASE_URL}/opportunities/upsert`);
      expect(oppBody.pipelineId).toBe('pipe_01');
      expect(oppBody.pipelineStageId).toBe('stage_closed_won');
      expect(oppBody.monetaryValue).toBe(4500);
    });
  });
});

