const app = require('./app');
const config = require('./config');
const logger = require('./utils/logger');

const server = app.listen(config.port, () => {
  logger.info(`GHL Webhook Listener running on port ${config.port}`, {
    port: config.port,
    env: config.env,
    endpoint: `/api/v1/ghl-webhook`,
  });
});

// Graceful shutdown handling for container orchestrators (ECS / Kubernetes)
function shutdown(signal) {
  logger.info(`Received ${signal}. Closing HTTP server gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed. Exiting process.');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = server;
