import { SettlementService } from '../services/settlement.service';
import { logger } from '../utils/logger';

let intervalId: NodeJS.Timeout | null = null;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Execute daily fiat settlement for all eligible FIAT merchants
 */
export async function runDailyFiatSettlementJob(): Promise<void> {
  try {
    logger.info('[DailySettlementJob] Starting scheduled daily fiat settlement...');
    const result = await SettlementService.processDailyFiatSettlement();
    logger.info(
      `[DailySettlementJob] Finished daily fiat settlement: ${result.processed} processed, ${result.succeeded} succeeded, ${result.failed} failed, ${result.skipped} skipped.`
    );
  } catch (error: any) {
    logger.error('[DailySettlementJob] Error running daily fiat settlement:', error);
  }
}

/**
 * Start recurring background job (runs every 24 hours)
 */
export function startDailySettlementCron(): void {
  logger.info('[DailySettlementJob] Initializing 24-hour daily fiat settlement cron...');

  if (!intervalId) {
    intervalId = setInterval(() => {
      runDailyFiatSettlementJob().catch((err) => {
        logger.warn('[DailySettlementJob] Error in daily settlement execution:', err);
      });
    }, TWENTY_FOUR_HOURS_MS);

    if (intervalId.unref) {
      intervalId.unref();
    }
  }
}

/**
 * Stop background job
 */
export function stopDailySettlementCron(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[DailySettlementJob] Stopped daily fiat settlement cron.');
  }
}
