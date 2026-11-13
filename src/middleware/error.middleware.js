const logger = require('../utils/logger');

/**
 * Centralized Express error-handling middleware.
 */
function errorHandler(err, req, res, _next) {
  const statusCode = err.status || err.statusCode || 500;
  const message =
    err.type === 'entity.parse.failed'
      ? 'Invalid JSON payload provided.'
      : err.message || 'Internal Server Error';

  logger.error('Express request error', {
    statusCode,
    message,
    path: req.originalUrl,
    method: req.method,
    stack: err.stack,
  });

  res.status(statusCode).json({
    status: 'error',
    message,
  });
}

module.exports = {
  errorHandler,
};
