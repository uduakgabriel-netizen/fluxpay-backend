import { logger } from '../utils/logger';
import { processDailySettlement } from '../services/settlement.service';

/**
 * Daily Settlement Cron Job
 *
 * Runs once per day at ~23:59 UTC to batch-process all unsettled
 * COMPLETED payments for every merchant, grouped by token.
 *
 * Schedule: Every 24 hours (86400000 ms)
 */

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Run the daily settlement batch once
 */
export async function runDailySettlement(): Promise<void> {
  const timestamp = new Date().toISOString();
  logger.info(`[Cron] Daily settlement started at ${timestamp}`);

  try {
    const result = await processDailySettlement();

    logger.info(
      `[Cron] Daily settlement complete — ` +
        `${result.merchantCount} merchant(s) checked, ` +
        `${result.settlementsCreated} settlement(s) created, ` +
        `$${result.totalAmount.toFixed(2)} total settled`
    );
  } catch (error) {
    logger.error('[Cron] Daily settlement error:', error);
  }
}

