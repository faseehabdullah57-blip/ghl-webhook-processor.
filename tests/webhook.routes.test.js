const crypto = require('crypto');
const request = require('supertest');
const axios = require('axios');
const app = require('../src/app');
const config = require('../src/config');
const logger = require('../src/utils/logger');
const { computeHmacSignature } = require('../src/middleware/auth.middleware');

jest.mock('axios');

describe('POST /api/v1/ghl-webhook Security & Integration Tests', () => {
  const validSecret = config.security.webhookSecret;

  beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockResolvedValue({ status: 200, data: { status: 'forwarded' } });
    if (app.apiLimiter && typeof app.apiLimiter.resetKey === 'function') {
      app.apiLimiter.resetKey('::ffff:127.0.0.1');
      app.apiLimiter.resetKey('127.0.0.1');
    }
  });

  it('returns 401 Unauthorized when the secret or signature header is missing', async () => {
    const response = await request(app)
      .post('/api/v1/ghl-webhook')
      .send({ contact_id: '12345' });

    expect(response.status).toBe(401);
    expect(response.body.status).toBe('error');
  });

  it('returns 403 Forbidden when an invalid secret token or signature is provided', async () => {
    const response = await request(app)
      .post('/api/v1/ghl-webhook')
      .set('x-ghl-signature', 'wrong_token_value')
      .send({ contact_id: '12345' });

    expect(response.status).toBe(403);
    expect(response.body.status).toBe('error');
  });

  it('authenticates valid HMAC-SHA256 signature in x-highlevel-signature against raw request body', async () => {
    const payload = {
      contact_id: 'ghl_hmac_001',
      email: 'hmac.user@example.com',
      phone: '4155551234',
    };
    const rawBody = JSON.stringify(payload);
    const hmacSignature = computeHmacSignature(rawBody, validSecret);

    const response = await request(app)
      .post('/api/v1/ghl-webhook')
      .set('Content-Type', 'application/json')
      .set('x-highlevel-signature', hmacSignature)
      .send(rawBody);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('accepted');
    expect(response.body.trackingId).toBeDefined();
  });

  it('authenticates valid HMAC-SHA256 signature in x-ghl-signature and rejects tampered body', async () => {
    const originalPayload = { contact_id: 'ghl_hmac_002', email: 'original@example.com' };
    const tamperedPayload = { contact_id: 'ghl_hmac_002', email: 'attacker@example.com' };
    const validHmac = crypto
      .createHmac('sha256', validSecret)
      .update(JSON.stringify(originalPayload))
      .digest('hex');

    // Valid body matches HMAC
    const okResponse = await request(app)
      .post('/api/v1/ghl-webhook')
      .set('Content-Type', 'application/json')
      .set('x-ghl-signature', `sha256=${validHmac}`)
      .send(JSON.stringify(originalPayload));

    expect(okResponse.status).toBe(200);

    // Tampered body fails HMAC verification
    const tamperedResponse = await request(app)
      .post('/api/v1/ghl-webhook')
      .set('Content-Type', 'application/json')
      .set('x-ghl-signature', validHmac)
      .send(JSON.stringify(tamperedPayload));

    expect(tamperedResponse.status).toBe(403);
    expect(tamperedResponse.body.status).toBe('error');
  });

  it('supports shared-secret authentication via x-webhook-secret and Authorization Bearer headers', async () => {
    const payload = { contact_id: 'ghl_shared_003' };

    const secretHeaderRes = await request(app)
      .post('/api/v1/ghl-webhook')
      .set('x-webhook-secret', validSecret)
      .send(payload);
    expect(secretHeaderRes.status).toBe(200);

    const bearerRes = await request(app)
      .post('/api/v1/ghl-webhook')
      .set('Authorization', `Bearer ${validSecret}`)
      .send(payload);
    expect(bearerRes.status).toBe(200);
  });

  it('rejects replay attacks when x-webhook-timestamp is older than 5 minutes', async () => {
    const payload = { contact_id: 'ghl_replay_001' };
    const expiredTimestamp = Date.now() - 6 * 60 * 1000; // 6 minutes ago

    const expiredRes = await request(app)
      .post('/api/v1/ghl-webhook')
      .set('x-webhook-secret', validSecret)
      .set('x-webhook-timestamp', String(expiredTimestamp))
      .send(payload);

    expect(expiredRes.status).toBe(401);
    expect(expiredRes.body.message).toMatch(/timestamp/i);

    // Fresh timestamp succeeds
    const freshRes = await request(app)
      .post('/api/v1/ghl-webhook')
      .set('x-webhook-secret', validSecret)
      .set('x-webhook-timestamp', String(Date.now()))
      .send(payload);

    expect(freshRes.status).toBe(200);
  });

  it('returns 400 Bad Request when payload is empty', async () => {
    const response = await request(app)
      .post('/api/v1/ghl-webhook')
      .set('x-ghl-signature', validSecret)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.status).toBe('error');
  });

  it('immediately returns 200 OK with a trackingId on valid payload and triggers background processing', async () => {
    const sampleGhlPayload = {
      contact_id: 'ghl_lead_777',
      first_name: 'Marcus',
      last_name: 'Vance',
      email: '  MARCUS.VANCE@ENTERPRISE.IO ',
      phone: '(512) 888-9900',
      tags: ['utm_campaign', 'deal_stage:qualified'],
      customData: {
        utm_campaign: 'q4_enterprise_outbound',
      },
    };

    const response = await request(app)
      .post('/api/v1/ghl-webhook')
      .set('x-ghl-signature', validSecret)
      .send(sampleGhlPayload);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('accepted');
    expect(response.body.trackingId).toBeDefined();
    expect(typeof response.body.trackingId).toBe('string');

    // Wait briefly for setImmediate asynchronous processing to complete
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(axios.post).toHaveBeenCalledTimes(1);
    const [calledUrl, forwardedPayload, requestConfig] = axios.post.mock.calls[0];
    expect(calledUrl).toBe(config.downstream.url);
    expect(forwardedPayload.trackingId).toBe(response.body.trackingId);
    expect(forwardedPayload.contact.email).toBe('marcus.vance@enterprise.io');
    expect(forwardedPayload.contact.phone).toBe('+15128889900');
    expect(forwardedPayload.customFields).toEqual({
      utm_campaign: 'q4_enterprise_outbound',
      deal_stage: 'qualified',
    });
    expect(requestConfig.headers['X-Tracking-Id']).toBe(response.body.trackingId);
  });

  it('exposes a /health endpoint returning 200 OK', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('redacts sensitive headers, API keys, and raw email/phone PII from log entries', () => {
    const rawLogEntry = {
      level: 'error',
      message: 'Failed processing lead john.doe@secret.org with phone +14155552671 and Bearer secret_tok_99',
      authorization: 'Bearer secret_jwt_token',
      'x-ghl-signature': 'raw_hmac_sig',
      'x-webhook-secret': 'raw_webhook_secret',
      DOWNSTREAM_API_KEY: 'raw_downstream_key',
      normalizedEmail: 'john.doe@secret.org',
      normalizedPhone: '+14155552671',
    };

    const redacted = logger.redactSensitiveData(rawLogEntry);

    expect(redacted.authorization).toBe('[REDACTED]');
    expect(redacted['x-ghl-signature']).toBe('[REDACTED]');
    expect(redacted['x-webhook-secret']).toBe('[REDACTED]');
    expect(redacted.DOWNSTREAM_API_KEY).toBe('[REDACTED]');
    expect(redacted.normalizedEmail).toBe('[REDACTED_EMAIL]');
    expect(redacted.normalizedPhone).toBe('[REDACTED_PHONE]');
    expect(redacted.message).not.toContain('john.doe@secret.org');
    expect(redacted.message).not.toContain('+14155552671');
    expect(redacted.message).not.toContain('secret_tok_99');
  });

  it('enforces rate limiting (429 Too Many Requests) when exceeding 120 requests per minute', async () => {
    let lastResponse = null;
    for (let i = 0; i < 121; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      lastResponse = await request(app).get('/health');
    }

    expect(lastResponse.status).toBe(429);
    expect(lastResponse.body.status).toBe('error');
  });
});
