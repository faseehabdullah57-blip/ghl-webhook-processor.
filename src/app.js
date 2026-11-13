const express = require('express');
const helmet = require('helmet');
const webhookRoutes = require('./routes/webhook.routes');
const adminRoutes = require('./routes/admin.routes');
const { errorHandler } = require('./middleware/error.middleware');

/**
 * Built-in sliding-window rate limiter fallback in case `express-rate-limit` is not installed,
 * exposing the same middleware interface and `.resetKey(ip)` method.
 */
function createFallbackRateLimiter({ windowMs = 60 * 1000, max = 120, message }) {
  const hits = new Map();

  const limiter = (req, res, next) => {
    const key = req.ip || '127.0.0.1';
    const now = Date.now();
    const record = hits.get(key);

    if (!record || now > record.resetTime) {
      hits.set(key, { count: 1, resetTime: now + windowMs });
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, max - 1)));
      return next();
    }

    record.count += 1;
    const remaining = Math.max(0, max - record.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));

    if (record.count > max) {
      return res.status(429).json(
        message || {
          status: 'error',
          message: 'Too many requests from this IP, please try again after a minute.',
        }
      );
    }

    return next();
  };

  limiter.resetKey = (key) => {
    if (key) {
      hits.delete(key);
    } else {
      hits.clear();
    }
  };

  return limiter;
}

let rateLimitFactory = createFallbackRateLimiter;
try {
  // eslint-disable-next-line global-require
  rateLimitFactory = require('express-rate-limit');
} catch {
  // Use built-in rate limiter fallback if express-rate-limit is not installed in node_modules
}

const app = express();

// Security headers
app.use(helmet());

// Rate limiting to protect against Denial-of-Service (DoS) floods (120 req/min per IP)
const apiLimiter = rateLimitFactory({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'error',
    message: 'Too many requests from this IP, please try again after a minute.',
  },
});

app.use(apiLimiter);

// Parse incoming JSON payloads with strict 100kb limit and capture rawBody for HMAC verification
app.use(
  express.json({
    limit: '100kb',
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);

// Health check endpoint for load balancers & uptime monitors
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'ghl-webhook-processor',
    uptime: process.uptime(),
  });
});

// Mount API v1 routes (Webhook ingestion + Admin DLQ & Bi-Directional GHL Sync)
app.use('/api/v1', webhookRoutes);
app.use('/api/v1', adminRoutes);

// 404 handler for unknown routes
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: `Route ${req.method} ${req.originalUrl} not found.`,
  });
});

// Centralized error middleware
app.use(errorHandler);

app.apiLimiter = apiLimiter;

module.exports = app;
