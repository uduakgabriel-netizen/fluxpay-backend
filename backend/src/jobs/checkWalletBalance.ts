import { logger } from '../utils/logger';
import { getWalletBalance } from '../services/solana-wallet.service';
import { AlertService } from '../services/alert.service';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour


export async function checkWalletBalance() {
  try {
    const address = process.env.FLUXPAY_WALLET_PUBLIC_KEY;
    if (!address) {
      logger.warn('[WalletBalanceJob] FLUXPAY_WALLET_PUBLIC_KEY not configured.');
      return;
    }

    const { sol } = await getWalletBalance(address);
    
    logger.info(`[WalletBalanceJob] Checked balance for target wallet: ${sol} SOL`);
    
    await AlertService.alertLowWalletBalance(address, sol);
  } catch (error: any) {
    logger.error('[WalletBalanceJob] Error checking wallet balance:', error.message);
  }
}

