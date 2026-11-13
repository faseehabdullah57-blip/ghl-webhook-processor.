const axios = require('axios');
const fs = require('fs/promises');
const dlqService = require('../src/services/dlq.service');
const {
  forwardToDownstreamWithRetry,
  processWebhookPayload,
} = require('../src/services/webhookProcessor.service');

jest.mock('axios');

describe('Webhook Processor Service (Retry & Exponential Backoff)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALERT_WEBHOOK_URL;
  });

  afterAll(async () => {
    try {
      await fs.unlink(dlqService.getDlqFilePath());
    } catch {
      // ignore if already removed
    }
  });

  it('succeeds on the first attempt when downstream endpoint returns 200', async () => {
    axios.post.mockResolvedValueOnce({
      status: 200,
      data: { synced: true, remoteId: 'crm_001' },
    });

    const payload = {
      contact_id: 'cnt_100',
      email: 'TEST@DOMAIN.COM',
      phone: '4155550100',
      tags: ['campaign_id'],
      customData: { campaign_id: 'cmp_spring_26' },
    };

    const result = await processWebhookPayload(payload, 'track-success-1', {
      initialBackoffMs: 5,
    });

    expect(result.success).toBe(true);
    expect(result.downstreamResponse).toEqual({ synced: true, remoteId: 'crm_001' });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(result.structuredPayload.contact.email).toBe('test@domain.com');
    expect(result.structuredPayload.contact.phone).toBe('+14155550100');
    expect(result.structuredPayload.customFields.campaign_id).toBe('cmp_spring_26');
  });

  it('retries failed requests with exponential backoff and succeeds on the 3rd attempt', async () => {
    axios.post
      .mockRejectedValueOnce(new Error('ETIMEDOUT: Downstream timeout'))
      .mockRejectedValueOnce({
        message: 'Service Unavailable',
        response: { status: 503 },
      })
      .mockResolvedValueOnce({
        status: 201,
        data: { synced: true, attemptRecovered: 3 },
      });

    const structuredPayload = {
      trackingId: 'track-retry-3',
      contact: { contactId: 'cnt_200' },
      customFields: {},
    };

    const response = await forwardToDownstreamWithRetry(structuredPayload, {
      maxAttempts: 3,
      initialBackoffMs: 5,
    });

    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(response).toEqual({ synced: true, attemptRecovered: 3 });
  });

  it('exhausts all 3 retry attempts and returns failure state gracefully', async () => {
    axios.post.mockRejectedValue(new Error('502 Bad Gateway'));

    const rawPayload = {
      contact_id: 'cnt_fail_99',
      email: 'fail@example.com',
    };

    const result = await processWebhookPayload(rawPayload, 'track-exhausted', {
      maxAttempts: 3,
      initialBackoffMs: 5,
    });

    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(false);
    expect(result.error).toBe('502 Bad Gateway');
  });
});
