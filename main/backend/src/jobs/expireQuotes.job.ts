import { QuoteService } from '../services/quote.service';
import { logger } from '../utils/logger';

let intervalId: NodeJS.Timeout | null = null;
const ONE_MINUTE_MS = 60 * 1000;

/**
 * Execute the expired quotes cleanup
 */
export async function runExpireQuotesJob(): Promise<void> {
  try {
    const cleaned = await QuoteService.cleanupExpiredQuotes();
    if (cleaned > 0) {
      logger.info(`[ExpireQuotesJob] Cleaned up ${cleaned} expired quotes.`);
    }
  } catch (error: any) {
    logger.error('[ExpireQuotesJob] Unexpected error during quote cleanup:', error);
  }
}

/**
 * Start recurring background job (runs every minute)
 */
export function startExpireQuotesCron(): void {
  logger.info('[ExpireQuotesJob] Initializing 1-minute quote expiration job...');

  if (!intervalId) {
    intervalId = setInterval(() => {
      runExpireQuotesJob().catch((err) => {
        logger.warn('[ExpireQuotesJob] Error running expire quotes job:', err);
      });
    }, ONE_MINUTE_MS);

    if (intervalId.unref) {
      intervalId.unref();
    }
  }
}

/**
 * Stop the background job
 */
export function stopExpireQuotesCron(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[ExpireQuotesJob] Expire quotes job stopped.');
  }
}
