import { OfframpExecutionService } from '../services/offrampExecution.service';
import { logger } from '../utils/logger';

let intervalId: NodeJS.Timeout | null = null;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Execute transaction cleanup: finds transactions in AWAITING_SIGNATURE > 10m
 * and marks them FAILED with SIGNATURE_TIMEOUT.
 */
export async function runTransactionCleanupJob(): Promise<void> {
  try {
    const cleaned = await OfframpExecutionService.cleanupExpiredTransactions();
    if (cleaned > 0) {
      logger.info(`[TransactionCleanupJob] Cleaned up ${cleaned} expired transactions.`);
    }
  } catch (error: any) {
    logger.error('[TransactionCleanupJob] Error during transaction cleanup:', error);
  }
}

/**
 * Start recurring background job (runs every 5 minutes)
 */
export function startTransactionCleanupCron(): void {
  logger.info('[TransactionCleanupJob] Initializing 5-minute transaction cleanup cron...');

  if (!intervalId) {
    intervalId = setInterval(() => {
      runTransactionCleanupJob().catch((err) => {
        logger.warn('[TransactionCleanupJob] Error in cleanup cron execution:', err);
      });
    }, FIVE_MINUTES_MS);

    if (intervalId.unref) {
      intervalId.unref();
    }
  }
}

/**
 * Stop background job
 */
export function stopTransactionCleanupCron(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[TransactionCleanupJob] Stopped transaction cleanup cron.');
  }
}
