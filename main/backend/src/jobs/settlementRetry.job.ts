import { SettlementService } from '../services/settlement.service';
import { logger } from '../utils/logger';

let intervalId: NodeJS.Timeout | null = null;
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Execute retry for failed settlements (retryCount < 3)
 */
export async function runSettlementRetryJob(): Promise<void> {
  try {
    const result = await SettlementService.retryFailedSettlements();
    if (result.retried > 0) {
      logger.info(
        `[SettlementRetryJob] Retried ${result.retried} failed settlements: ${result.succeeded} succeeded, ${result.failed} failed.`
      );
    }
  } catch (error: any) {
    logger.error('[SettlementRetryJob] Error during settlement retries:', error);
  }
}

/**
 * Start recurring background job (runs every hour)
 */
export function startSettlementRetryCron(): void {
  logger.info('[SettlementRetryJob] Initializing 1-hour settlement retry cron...');

  if (!intervalId) {
    intervalId = setInterval(() => {
      runSettlementRetryJob().catch((err) => {
        logger.warn('[SettlementRetryJob] Error running settlement retry job:', err);
      });
    }, ONE_HOUR_MS);

    if (intervalId.unref) {
      intervalId.unref();
    }
  }
}

/**
 * Stop background job
 */
export function stopSettlementRetryCron(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[SettlementRetryJob] Stopped settlement retry cron.');
  }
}
