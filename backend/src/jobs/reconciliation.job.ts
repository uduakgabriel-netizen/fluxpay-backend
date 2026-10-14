import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
import { EscrowService } from '../services/escrow.service';
import { AlertService } from '../services/alert.service';
import { EmailService } from '../services/email.service';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();

const TOLERANCE = 0.01;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
let intervalId: NodeJS.Timeout | null = null;

export interface ReconciliationResult {
  id: string;
  timestamp: Date;
  expectedBalance: string;
  actualBalance: string;
  difference: string;
  status: 'MATCH' | 'MISMATCH';
}

/**
 * Executes escrow reconciliation check
 */
export async function runReconciliationJob(): Promise<ReconciliationResult> {
  const timestamp = new Date();
  logger.info(`[ReconciliationJob] ═════════════════════════════════════════════`);
  logger.info(`[ReconciliationJob] Starting Daily Escrow Reconciliation Check...`);

  // 1. Expected balance across all merchants
  const totals = await EscrowService.getEscrowTotals();
  const expectedNum = parseFloat(totals.totalEscrowUsdc);

  // 2. Actual on-chain balance in Escrow Wallet via RPC
  const actualNum = await EscrowService.getOnChainEscrowUsdcBalance();

  const diffNum = Math.abs(actualNum - expectedNum);
  const isMatch = diffNum <= TOLERANCE;
  const status: 'MATCH' | 'MISMATCH' = isMatch ? 'MATCH' : 'MISMATCH';

  const expectedBalance = expectedNum.toFixed(2);
  const actualBalance = actualNum.toFixed(2);
  const difference = diffNum.toFixed(2);

  const recId = `rec_${randomBytes(8).toString('hex')}`;
  const record: ReconciliationResult = {
    id: recId,
    timestamp,
    expectedBalance,
    actualBalance,
    difference,
    status,
  };

  // 3. Store in database
  try {
    await prisma.reconciliation.create({
      data: {
        id: recId,
        timestamp,
        expectedBalance,
        actualBalance,
        difference,
        status,
      },
    });
    logger.info(`[ReconciliationJob] Stored record in database: ${recId}`);
  } catch (err: any) {
    logger.warn(`[ReconciliationJob] DB storage fallback: ${err.message}`);
  }

  // 4. Log summary
  if (isMatch) {
    logger.info(
      `[ReconciliationJob] ✅ MATCH (Tolerance: ${TOLERANCE} USDC) | Expected: ${expectedBalance} USDC | Actual: ${actualBalance} USDC | Diff: ${difference} USDC`
    );
    console.log(
      `[Reconciliation] ✅ MATCH | Expected: ${expectedBalance} USDC | On-Chain: ${actualBalance} USDC | Diff: ${difference} USDC`
    );
  } else {
    logger.error(
      `[ReconciliationJob] ❌ MISMATCH DETECTED! Expected: ${expectedBalance} USDC | Actual: ${actualBalance} USDC | Diff: ${difference} USDC`
    );
    console.error(
      `[Reconciliation] 🚨 MISMATCH! Expected: ${expectedBalance} USDC | On-Chain: ${actualBalance} USDC | Diff: ${difference} USDC`
    );

    // Alert Discord
    await AlertService.alertReconciliationMismatch({
      expectedBalance,
      actualBalance,
      difference,
    }).catch(() => {});

    // Alert Admin Email
    const adminEmail = process.env.ADMIN_EMAIL || process.env.RESEND_FROM_EMAIL || 'admin@fluxpay.dev';
    await EmailService.sendPayoutFailed(adminEmail, undefined, {
      payoutId: recId,
      amount: difference,
      currency: 'USDC',
      reason: `Reconciliation MISMATCH: Expected ${expectedBalance} USDC, On-Chain ${actualBalance} USDC`,
    }).catch(() => {});
  }

  logger.info(`[ReconciliationJob] ═════════════════════════════════════════════`);
  return record;
}

/**
 * Start recurring reconciliation job (every 24 hours)
 */
export function startReconciliationCron(): void {
  logger.info('[ReconciliationJob] Initializing 24-hour daily escrow reconciliation cron...');

  if (!intervalId) {
    intervalId = setInterval(() => {
      runReconciliationJob().catch((err) => {
        logger.error('[ReconciliationJob] Error running daily reconciliation:', err);
      });
    }, TWENTY_FOUR_HOURS_MS);

    if (intervalId.unref) {
      intervalId.unref();
    }
  }
}

/**
 * Stop background reconciliation job
 */
export function stopReconciliationCron(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('[ReconciliationJob] Stopped daily escrow reconciliation cron.');
  }
}
