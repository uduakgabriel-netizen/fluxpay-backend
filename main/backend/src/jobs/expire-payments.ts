import { logger } from '../utils/logger';
import { PrismaClient } from '@prisma/client';
import { expirePendingPayments } from '../services/payment.service';
import { expireCheckoutSessions } from '../services/checkout.service';
import { deliverWebhook } from '../utils/webhook';

const prisma = new PrismaClient();

/**
 * Expire Payments Cron Job
 * 
 * Runs every hour to mark PENDING payments that have passed their
 * expiresAt timestamp as EXPIRED. Sends webhooks to merchants.
 * 
 * Schedule: Every hour (0 * * * *)
 */

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour in milliseconds

/**
 * Run the expiration check once
 */
export async function runExpirePayments(): Promise<void> {
  try {
    // Find payments that will be expired (before we expire them) to send webhooks
    const aboutToExpire = await prisma.payment.findMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: new Date() },
      },
      select: { id: true, merchantId: true, amount: true, token: true },
    });

    const count = await expirePendingPayments();

    if (count > 0) {
      logger.info(`[Cron] Expired ${count} pending payment(s)`);

      // Send webhooks for expired payments
      for (const payment of aboutToExpire) {
        await deliverWebhook({
          merchantId: payment.merchantId,
          event: 'payment.expired',
          data: {
            paymentId: payment.id,
            amount: payment.amount,
            token: payment.token,
            expiredAt: new Date().toISOString(),
          },
        }).catch((err) =>
          logger.error(`[Cron] Failed to send expiry webhook for ${payment.id}:`, err)
        );
      }
    }

    // Also expire stale checkout sessions
    const checkoutCount = await expireCheckoutSessions();
    if (checkoutCount > 0) {
      logger.info(`[Cron] Expired ${checkoutCount} checkout session(s)`);
    }
  } catch (error) {
    logger.error('[Cron] Error expiring payments:', error);
  }
}

/**
 * Start the recurring expiration job using setInterval
 * This avoids an external dependency on node-cron
 */
