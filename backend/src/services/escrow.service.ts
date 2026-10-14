import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
import { getEscrowWalletPublicKey } from '../config/wallets';
import { getConnection, withFailover } from '../config/solana';
import { PublicKey } from '@solana/web3.js';
import { getMintAddress } from '../utils/token-registry';

const prisma = new PrismaClient();

// In-memory fallback map for merchant escrow balances
export const memoryMerchantEscrow = new Map<string, string>();

export class EscrowService {
  /**
   * Increment merchant escrow balance upon confirmed payment for FIAT merchants
   */
  static async incrementMerchantEscrow(merchantId: string, amount: number | string): Promise<string> {
    const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(numAmount) || numAmount <= 0) return '0';

    let updatedBalance = '0';
    try {
      const merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { id: true, escrowBalance: true, settlementType: true },
      });

      if (merchant) {
        // Only increment for FIAT settlements
        if (merchant.settlementType === 'FIAT') {
          const current = parseFloat(merchant.escrowBalance || '0');
          updatedBalance = (current + numAmount).toFixed(2);

          await prisma.merchant.update({
            where: { id: merchantId },
            data: { escrowBalance: updatedBalance },
          });

          memoryMerchantEscrow.set(merchantId, updatedBalance);
          logger.info(`[Escrow] + Incremented merchant ${merchantId} escrowBalance by +${numAmount.toFixed(2)} → Total: ${updatedBalance} USDC`);
          return updatedBalance;
        }
      }
    } catch (err: any) {
      logger.warn(`[Escrow] DB increment failed, using memory fallback: ${err.message}`);
    }

    // In-memory fallback
    const currentMem = parseFloat(memoryMerchantEscrow.get(merchantId) || '0');
    updatedBalance = (currentMem + numAmount).toFixed(2);
    memoryMerchantEscrow.set(merchantId, updatedBalance);
    logger.info(`[Escrow Memory] + Incremented merchant ${merchantId} escrowBalance by +${numAmount.toFixed(2)} → Total: ${updatedBalance} USDC`);
    return updatedBalance;
  }

  /**
   * Decrement merchant escrow balance when batch settlement completes
   */
  static async decrementMerchantEscrow(merchantId: string, amount: number | string): Promise<string> {
    const numAmount = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(numAmount) || numAmount <= 0) return '0';

    let updatedBalance = '0';
    try {
      const merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { id: true, escrowBalance: true },
      });

      if (merchant) {
        const current = parseFloat(merchant.escrowBalance || '0');
        updatedBalance = Math.max(0, current - numAmount).toFixed(2);

        await prisma.merchant.update({
          where: { id: merchantId },
          data: { escrowBalance: updatedBalance },
        });

        memoryMerchantEscrow.set(merchantId, updatedBalance);
        logger.info(`[Escrow] - Decremented merchant ${merchantId} escrowBalance by -${numAmount.toFixed(2)} → Remaining: ${updatedBalance} USDC`);
        return updatedBalance;
      }
    } catch (err: any) {
      logger.warn(`[Escrow] DB decrement failed, using memory fallback: ${err.message}`);
    }

    const currentMem = parseFloat(memoryMerchantEscrow.get(merchantId) || '0');
    updatedBalance = Math.max(0, currentMem - numAmount).toFixed(2);
    memoryMerchantEscrow.set(merchantId, updatedBalance);
    logger.info(`[Escrow Memory] - Decremented merchant ${merchantId} escrowBalance by -${numAmount.toFixed(2)} → Remaining: ${updatedBalance} USDC`);
    return updatedBalance;
  }

  /**
   * Get total expected escrow balance and breakdown across all merchants
   */
  static async getEscrowTotals(): Promise<{
    totalEscrowUsdc: string;
    merchants: Array<{ merchantId: string; balance: string }>;
  }> {
    let merchantList: Array<{ id: string; escrowBalance: string | null }> = [];
    try {
      merchantList = await prisma.merchant.findMany({
        where: {
          OR: [
            { settlementType: 'FIAT' },
            { escrowBalance: { not: '0' } },
          ],
        },
        select: { id: true, escrowBalance: true },
      });
    } catch (err: any) {
      logger.warn(`[Escrow] DB query failed, using memory map: ${err.message}`);
    }

    if (merchantList.length === 0 && memoryMerchantEscrow.size > 0) {
      merchantList = Array.from(memoryMerchantEscrow.entries()).map(([id, balance]) => ({
        id,
        escrowBalance: balance,
      }));
    }

    const merchants = merchantList.map((m) => ({
      merchantId: m.id,
      balance: parseFloat(m.escrowBalance || '0').toFixed(2),
    }));

    const total = merchants.reduce((sum, m) => sum + parseFloat(m.balance), 0);

    return {
      totalEscrowUsdc: total.toFixed(2),
      merchants,
    };
  }

  /**
   * Fetch real on-chain USDC balance of the Escrow Wallet via Solana RPC
   */
  static async getOnChainEscrowUsdcBalance(): Promise<number> {
    try {
      const escrowPubkey = getEscrowWalletPublicKey();
      const usdcMint = getMintAddress('USDC');
      if (!usdcMint) {
        throw new Error('USDC mint address not found in token registry');
      }

      const balance = await withFailover(async (connection) => {
        // Query token accounts for escrow wallet owner and USDC mint
        const accounts = await connection.getParsedTokenAccountsByOwner(
          escrowPubkey,
          { mint: new PublicKey(usdcMint) }
        );

        if (!accounts || accounts.value.length === 0) {
          return 0;
        }

        let total = 0;
        for (const acc of accounts.value) {
          const uiAmount = acc.account.data.parsed.info.tokenAmount.uiAmount;
          if (typeof uiAmount === 'number') {
            total += uiAmount;
          }
        }
        return total;
      });

      return balance;
    } catch (err: any) {
      logger.error(`[Escrow] Failed to fetch on-chain USDC balance: ${err.message}`);
      return 0;
    }
  }
}
