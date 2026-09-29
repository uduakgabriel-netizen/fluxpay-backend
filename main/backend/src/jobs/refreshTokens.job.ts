import { TokenRegistryService } from '../services/tokenRegistry.service';
import { logger } from '../utils/logger';

let intervalId: NodeJS.Timeout | null = null;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Execute the token refresh task safely
 */
export async function runRefreshTokensJob(): Promise<void> {
  try {
    logger.info('[RefreshTokensJob] Starting scheduled token refresh...');
    const result = await TokenRegistryService.refreshTokens();
    logger.info(
      `[RefreshTokensJob] Completed token refresh: ${result.added} added, ${result.updated} updated, ${result.total} total sellable tokens.`
    );
  } catch (error: any) {
    logger.error('[RefreshTokensJob] Unexpected error during token refresh (server continuing):', error);
  }
}

/**
 * Start the token refresh cron job:
 * - Runs once on server startup
 * - Runs recurringly every 24 hours
 */
export function startRefreshTokensCron(): void {
  logger.info('[RefreshTokensJob] Initializing 24-hour token refresh cron...');

  // 1. Run once on startup (non-blocking)
  setImmediate(() => {
    runRefreshTokensJob().catch((err) => {
      logger.warn('[RefreshTokensJob] Startup token refresh error:', err);
    });
  });

  // 2. Schedule recurring execution every 24 hours
  if (!intervalId) {
    intervalId = setInterval(() => {
      runRefreshTokensJob().catch((err) => {
        logger.warn('[RefreshTokensJob] Recurring token refresh error:', err);
      });
    }, TWENTY_FOUR_HOURS_MS);

    // Unref timer so it doesn't block process exit if needed
    if (intervalId.unref) {
      intervalId.unref();
    }
  }
}

/**
 * Stop the cron job (for graceful shutdown or tests)
 */
export function stopRefreshTokensCron(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[RefreshTokensJob] Token refresh cron stopped.');
  }
}
