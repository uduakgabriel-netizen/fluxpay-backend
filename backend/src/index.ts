import { logger } from './utils/logger';
import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import { initWebhookQueue, shutdownWebhookQueue } from './utils/webhook';
import { initCronJobs, shutdownCronJobs } from './queues/jobQueue';
import { AlertService } from './services/alert.service';

const PORT = parseInt(process.env.PORT || '5000', 10);

async function bootstrap() {
  const server = app.listen(PORT, () => {
    logger.info(`
⚡ FluxPay Backend Server (Non-Custodial)
─────────────────────────────────────────
Port:         ${PORT}
Environment:  ${process.env.NODE_ENV || 'development'}
Network:      ${process.env.SOLANA_NETWORK || 'devnet'}
Architecture: Non-Custodial (customer → Jupiter → merchant)
Health:       /api/health
Auth API:     /api/auth
Payments:     /api/payments
Refunds:      /api/refunds
Settlements:  /api/settlements
API Keys:     /api/api-keys
Webhooks:     /api/webhooks
Helius:       /api/webhooks/helius
Blockchain:   http://localhost:${PORT}/api/blockchain
Tokens:       /api/tokens
Merchants:    /api/merchants
Checkout:     /api/checkout
─────────────────────────────────────────
    `);

    // Run background services AFTER server is live (non-blocking, critical for Render port detection)
    setImmediate(() => {
      initWebhookQueue()
        .then(() => logger.info('Webhook queue initialized'))
        .catch(err => logger.error('Webhook queue error:', err));

      initCronJobs()
        .then(() => logger.info('Cron jobs initialized'))
        .catch(err => logger.error('Cron jobs error:', err));

      AlertService.alertServerStartup().catch(() => {});
    });
  });

  // Handle port errors
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${PORT} is already in use`);
    } else {
      logger.error(`[Server] Startup error: ${err.message}`);
    }
    process.exit(1);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`[Server] Received ${signal}. Shutting down gracefully...`);

    await AlertService.alertServerShutdown(signal).catch(() => {});
    await shutdownCronJobs();
    await shutdownWebhookQueue();

    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((error) => {
  logger.error('[Server] Fatal startup error:', error);
  process.exit(1);
});