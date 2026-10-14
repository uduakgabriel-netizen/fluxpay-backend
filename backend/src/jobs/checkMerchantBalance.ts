import { logger } from '../utils/logger';
/**
 * Merchant Balance Check Job
 *
 * Periodically checks all merchant wallets' SOL balance.
 * Alerts admin via Discord and merchant via email if balance is low.
 * Low SOL means the merchant can't receive new token types (no ATA rent).
 *
 * Schedule: Every 4 hours (to avoid excessive RPC calls)
 */

import { PrismaClient } from '@prisma/client';
import { getWalletBalance } from '../services/solana-wallet.service';
import { AlertService } from '../services/alert.service';
import { EmailService } from '../services/email.service';

const prisma = new PrismaClient();
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MIN_MERCHANT_SOL = 0.005; // Minimum for ATA rent


export async function checkMerchantBalances() {
  try {
    const merchants = await prisma.merchant.findMany({
      select: {
        id: true,
        walletAddress: true,
        email: true,
        businessName: true,
      },
    });

    logger.info(`[MerchantBalanceJob] Checking ${merchants.length} merchant wallets...`);

    let lowBalanceCount = 0;

    for (const merchant of merchants) {
      try {
        const { sol } = await getWalletBalance(merchant.walletAddress);

        if (sol < MIN_MERCHANT_SOL) {
          lowBalanceCount++;
          logger.warn(
            `[MerchantBalanceJob] Low SOL: ${merchant.businessName} (${merchant.walletAddress.slice(0, 8)}...): ${sol.toFixed(6)} SOL`
          );

          // Discord alert for admin
          await AlertService.alertLowMerchantSol(
            merchant.walletAddress,
            sol,
            undefined,
            merchant.businessName
          ).catch(logger.error);

          // Email alert for merchant
          if (merchant.email) {
            await EmailService.sendLowBalanceWarning(merchant.email, {
              walletAddress: merchant.walletAddress,
              currentBalance: sol,
              requiredBalance: MIN_MERCHANT_SOL,
            }).catch(logger.error);
          }
        }
      } catch (error: any) {
        logger.error(
          `[MerchantBalanceJob] Error checking ${merchant.businessName}: ${error.message}`
        );
      }

      // Small delay between checks to avoid RPC rate limits
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    logger.info(
      `[MerchantBalanceJob] ✓ Checked ${merchants.length} merchants. ${lowBalanceCount} with low balance.`
    );
  } catch (error: any) {
    logger.error('[MerchantBalanceJob] Error:', error.message);
  }
}
