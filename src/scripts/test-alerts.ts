import { logger } from '../utils/logger';
import dotenv from '@dotenvx/dotenvx';
dotenv.config();

import { AlertService } from '../services/alert.service';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function verifyAlerts() {
  logger.info('Sending Test Alert - Swap Failure...');
  await AlertService.alertSwapFailure(
    'pay_test123xyz',
    'Exceeded max slippage after 5 attempts.',
    5
  );
  await sleep(1000);

  logger.info('Sending Test Alert - Swap Success...');
  await AlertService.alertSwapSuccess(
    'pay_test123xyz',
    '3zH1oWkZZkC6eBf3d6LHQ1xKryvWe2R2bJ4hQ4J8XW5zZ9nCQQ1A...',
    100.5,
    98.1
  );
  await sleep(1000);

  logger.info('Sending Test Alert - RPC Failover...');
  await AlertService.alertRpcFailover(
    'https://api.mainnet-beta.solana.com',
    'https://valid-fallback.solana.com',
    '503 Service Unavailable'
  );
  await sleep(1000);

  logger.info('Sending Test Alert - High Failure Rate...');
  // Force > 5 threshold
  await AlertService.alertHighSwapFailureRate(8.5);
  await sleep(1000);

  logger.info('Sending Test Alert - Webhook Failure...');
  await AlertService.alertWebhookFailure(
    'merch_7890',
    'payment.failed',
    'https://merchant.com/webhook',
    5
  );
  await sleep(1000);

  logger.info('Sending Test Alert - Low Wallet Balance...');
  // Force < 0.1 threshold
  await AlertService.alertLowWalletBalance(
    'FluxPayerWallet123456789...',
    0.05
  );
  await sleep(1000);

  logger.info('All test alerts sent! Check Discord #alerts channel.');
}

verifyAlerts().catch(logger.error);
