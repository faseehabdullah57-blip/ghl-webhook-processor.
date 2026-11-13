const fs = require('fs/promises');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

let writeQueue = Promise.resolve();

/**
 * Resolves the active DLQ storage file path.
 *
 * @returns {string}
 */
function getDlqFilePath() {
  return process.env.DLQ_FILE_PATH || config.dlq.filePath;
}

/**
 * Ensures the parent directory and DLQ JSON file exist, then reads and parses the queue.
 *
 * @returns {Promise<Array<Object>>}
 */
async function readDlqFile() {
  const filePath = getDlqFilePath();
  const dirPath = path.dirname(filePath);

  await fs.mkdir(dirPath, { recursive: true });

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (!raw || !raw.trim()) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    logger.warn('Failed to parse DLQ file; initializing empty queue', {
      errorMessage: err.message,
    });
    return [];
  }
}

/**
 * Atomically writes the array of failed events to the DLQ JSON file.
 *
 * @param {Array<Object>} events
 * @returns {Promise<void>}
 */
async function writeDlqFile(events) {
  const filePath = getDlqFilePath();
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(events, null, 2), 'utf8');
}

/**
 * Serializes file mutations through an in-memory promise chain to prevent race conditions.
 *
 * @param {Function} taskFn
 * @returns {Promise<*>}
 */
function withFileLock(taskFn) {
  const next = writeQueue.then(() => taskFn());
  writeQueue = next.catch(() => {});
  return next;
}

/**
 * Appends an exhausted webhook event to `data/dlq_failed_events.json` with an ISO timestamp.
 *
 * @param {Object} params
 * @param {string} params.trackingId
 * @param {Object} params.payload
 * @param {Object} [params.headers]
 * @param {string|Error} params.error
 * @param {number} [params.attempts]
 * @returns {Promise<Object>} The newly created DLQ entry
 */
async function enqueueFailedEvent({ trackingId, payload, headers = {}, error, attempts = 3 }) {
  return withFileLock(async () => {
    const events = await readDlqFile();
    const errorMessage = error instanceof Error ? error.message : String(error || 'Unknown error');

    const dlqEntry = {
      id: `dlq_${trackingId || Date.now()}`,
      trackingId,
      payload,
      headers,
      error: errorMessage,
      attempts,
      failedAt: new Date().toISOString(),
    };

    events.push(dlqEntry);
    await writeDlqFile(events);

    logger.warn('Enqueued failed webhook event to Dead-Letter Queue (DLQ)', {
      trackingId,
      dlqId: dlqEntry.id,
      attempts,
      errorMessage,
    });

    return dlqEntry;
  });
}

/**
 * Lists all failed webhook events currently stored in the Dead-Letter Queue.
 *
 * @returns {Promise<Array<Object>>}
 */
async function listFailedEvents() {
  return readDlqFile();
}

/**
 * Re-attempts delivery of all queued DLQ events sequentially using `forwarderFn`.
 * Removes succeeded items from the DLQ file and keeps events that still fail.
 *
 * @param {Function} [forwarderFn] - Async function `(payload, event) => Promise<*>`
 * @returns {Promise<{ replayed: number, succeeded: number, stillFailed: number }>}
 */
async function replayAllEvents(forwarderFn) {
  return withFileLock(async () => {
    const events = await readDlqFile();
    if (events.length === 0) {
      return { replayed: 0, succeeded: 0, stillFailed: 0 };
    }

    let activeForwarder = forwarderFn;
    if (typeof activeForwarder !== 'function') {
      // Lazy require to avoid circular dependency with webhookProcessor.service
      // eslint-disable-next-line global-require
      const { forwardToDownstreamWithRetry } = require('./webhookProcessor.service');
      activeForwarder = (payload) => forwardToDownstreamWithRetry(payload);
    }

    const remainingFailed = [];
    let succeeded = 0;

    for (const event of events) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await activeForwarder(event.payload, event);
        succeeded += 1;
        logger.info('DLQ event replayed successfully', {
          trackingId: event.trackingId,
          dlqId: event.id,
        });
      } catch (err) {
        const updatedEvent = {
          ...event,
          attempts: (event.attempts || 0) + 1,
          error: err instanceof Error ? err.message : String(err),
          lastReplayAttemptAt: new Date().toISOString(),
        };
        remainingFailed.push(updatedEvent);
        logger.warn('DLQ event replay failed; retaining in queue', {
          trackingId: event.trackingId,
          dlqId: event.id,
          errorMessage: updatedEvent.error,
        });
      }
    }

    await writeDlqFile(remainingFailed);

    return {
      replayed: events.length,
      succeeded,
      stillFailed: remainingFailed.length,
    };
  });
}

/**
 * Clears all events from the DLQ file (useful for testing and maintenance).
 *
 * @returns {Promise<void>}
 */
async function clearFailedEvents() {
  return withFileLock(async () => {
    await writeDlqFile([]);
  });
}

module.exports = {
  getDlqFilePath,
  enqueueFailedEvent,
  listFailedEvents,
  replayAllEvents,
  clearFailedEvents,
};

