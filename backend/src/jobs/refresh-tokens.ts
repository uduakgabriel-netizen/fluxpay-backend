import { logger } from '../utils/logger';
import TokenService from '../services/token.service'

let tokenRefreshJobId: NodeJS.Timeout | null = null

/**
 * Start the token refresh job.
 * Runs every 24 hours to update the FULL token cache from Jupiter.
 * Fetches ALL verified tokens, not just the top 10.
 */
export async function refreshTokens() {
  logger.info('[TokenRefreshJob] Running scheduled token refresh');
  await TokenService.refreshTokenCache();
}
/**
 * Stop the token refresh job (useful for cleanup)
 */
export function stopTokenRefreshJob() {
  if (tokenRefreshJobId) {
    clearInterval(tokenRefreshJobId)
    tokenRefreshJobId = null
    logger.info('Token refresh job stopped')
  }
}
