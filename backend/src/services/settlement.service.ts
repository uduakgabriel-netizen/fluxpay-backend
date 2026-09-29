import { logger } from '../utils/logger';
import { PrismaClient, SettlementStatus, Prisma } from '@prisma/client';
import { AppError } from './auth.service';
import { transferToMerchant } from '../utils/solana-transfer';

const prisma = new PrismaClient();

const MINIMUM_SETTLEMENT_AMOUNT = parseFloat(process.env.MIN_SETTLEMENT_AMOUNT || '10');
const SETTLEMENT_FEE_RATE = parseFloat(process.env.SETTLEMENT_FEE_RATE || '0.005'); // 0.5%
const FLUXPAY_WALLET = process.env.FLUXPAY_WALLET_ADDRESS || 'FluxPayMainWallet...';

// ─── Interfaces ─────────────────────────────────────────────

interface ListSettlementsInput {
  merchantId: string;
  page: number;
  limit: number;
  status?: SettlementStatus;
  fromDate?: string;
  toDate?: string;
}

// ─── List Settlements ───────────────────────────────────────

export async function listSettlements(input: ListSettlementsInput) {
  const { merchantId, page, limit, status, fromDate, toDate } = input;

  const where: Prisma.SettlementWhereInput = { merchantId };

  if (status) {
    where.status = status;
  }

  if (fromDate || toDate) {
    where.batchDate = {};
    if (fromDate) (where.batchDate as any).gte = new Date(fromDate);
    if (toDate) (where.batchDate as any).lte = new Date(toDate);
  }

  const total = await prisma.settlement.count({ where });

  const skip = (page - 1) * limit;
  const settlements = await prisma.settlement.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip,
    take: limit,
    select: {
      id: true,
      amount: true,
      token: true,
      paymentCount: true,
      status: true,
      txHash: true,
      fee: true,
      batchDate: true,
      createdAt: true,
      completedAt: true,
    },
  });

  // Summary
  const [settledAgg, pendingAgg] = await Promise.all([
    prisma.settlement.aggregate({
      where: { merchantId, status: 'COMPLETED' },
      _sum: { amount: true },
    }),
    prisma.payment.aggregate({
      where: {
        merchantId,
        status: 'COMPLETED',
        settled: false,
      },
      _sum: { amount: true },
    }),
  ]);

  return {
    data: settlements.map((s) => ({
      ...s,
      batchDate: s.batchDate.toISOString(),
      createdAt: s.createdAt.toISOString(),
      completedAt: s.completedAt?.toISOString() || null,
    })),
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    summary: {
      totalSettled: settledAgg._sum.amount || 0,
      pendingSettlement: pendingAgg._sum.amount || 0,
    },
  };
}

// ─── Get Settlement Details ─────────────────────────────────

export async function getSettlementById(settlementId: string, merchantId: string) {
  const settlement = await prisma.settlement.findFirst({
    where: {
      id: settlementId,
      merchantId,
    },
  });

  if (!settlement) {
    throw new AppError('Settlement not found', 404);
  }

  return {
    id: settlement.id,
    amount: settlement.amount,
    token: settlement.token,
    status: settlement.status,
    paymentCount: settlement.paymentCount,
    paymentIds: settlement.paymentIds,
    txHash: settlement.txHash,
    fromAddress: settlement.fromAddress,
    toAddress: settlement.toAddress,
    fee: settlement.fee,
    batchDate: settlement.batchDate.toISOString(),
    createdAt: settlement.createdAt.toISOString(),
    completedAt: settlement.completedAt?.toISOString() || null,
    failedAt: settlement.failedAt?.toISOString() || null,
    failureReason: settlement.failureReason,
  };
}

// ─── Manual Settlement (Admin) ──────────────────────────────

export async function processManualSettlement(merchantId: string, token?: string) {
  // Get merchant
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
  });

  if (!merchant) {
    throw new AppError('Merchant not found', 404);
  }

  // Find unsettled completed payments
  const paymentWhere: Prisma.PaymentWhereInput = {
    merchantId,
    status: 'COMPLETED',
    settled: false,
  };

  if (token) {
    paymentWhere.token = token.toUpperCase();
  }

  const payments = await prisma.payment.findMany({
    where: paymentWhere,
  });

  if (payments.length === 0) {
    throw new AppError('No unsettled payments found', 400);
  }

  // Group payments by token
  const byToken = groupBy(payments, 'token');
  const results: any[] = [];

  for (const [tokenKey, tokenPayments] of Object.entries(byToken)) {
    const totalAmount = tokenPayments.reduce((sum, p) => sum + p.amount, 0);

    // Check minimum amount
    if (totalAmount < MINIMUM_SETTLEMENT_AMOUNT) {
      results.push({
        token: tokenKey,
        skipped: true,
        reason: `Total amount $${totalAmount.toFixed(2)} is below minimum $${MINIMUM_SETTLEMENT_AMOUNT}`,
      });
      continue;
    }

    // Calculate fee
    const fee = Math.round(totalAmount * SETTLEMENT_FEE_RATE * 100) / 100;
    const netAmount = totalAmount - fee;

    // Create settlement record
    const settlement = await prisma.settlement.create({
      data: {
        merchantId,
        amount: netAmount,
        token: tokenKey,
        paymentIds: tokenPayments.map((p) => p.id),
        paymentCount: tokenPayments.length,
        fee,
        status: 'PROCESSING',
        fromAddress: FLUXPAY_WALLET,
        toAddress: merchant.walletAddress,
        batchDate: new Date(),
      },
    });

    try {
      // Transfer on-chain
      const txHash = await transferToMerchant(
        merchant.walletAddress,
        netAmount,
        tokenKey
      );

      // Mark settlement COMPLETED
      await prisma.settlement.update({
        where: { id: settlement.id },
        data: {
          status: 'COMPLETED',
          txHash,
          completedAt: new Date(),
        },
      });

      // Mark payments as settled
      await prisma.payment.updateMany({
        where: { id: { in: tokenPayments.map((p) => p.id) } },
        data: {
          settled: true,
          settledAt: new Date(),
        },
      });

      results.push({
        settlementId: settlement.id,
        token: tokenKey,
        amount: netAmount,
        fee,
        paymentCount: tokenPayments.length,
        txHash,
        status: 'COMPLETED',
      });
    } catch (error: any) {
      // Mark settlement FAILED
      await prisma.settlement.update({
        where: { id: settlement.id },
        data: {
          status: 'FAILED',
          failureReason: error.message,
          failedAt: new Date(),
        },
      });

      results.push({
        settlementId: settlement.id,
        token: tokenKey,
        amount: netAmount,
        fee,
        paymentCount: tokenPayments.length,
        status: 'FAILED',
        error: error.message,
      });
    }
  }

  return {
    message: 'Settlement processing complete',
    results,
  };
}

// ─── Daily Settlement Logic (called by cron) ────────────────

export async function processDailySettlement(): Promise<{
  merchantCount: number;
  settlementsCreated: number;
  totalAmount: number;
}> {
  const merchants = await prisma.merchant.findMany();

  let settlementsCreated = 0;
  let totalAmount = 0;

  for (const merchant of merchants) {
    // Get all COMPLETED payments not yet settled
    const payments = await prisma.payment.findMany({
      where: {
        merchantId: merchant.id,
        status: 'COMPLETED',
        settled: false,
      },
    });

    if (payments.length === 0) continue;

    // Group by token
    const byToken = groupBy(payments, 'token');

    for (const [tokenKey, tokenPayments] of Object.entries(byToken)) {
      const grossAmount = tokenPayments.reduce((sum, p) => sum + p.amount, 0);

      // Skip if below minimum
      if (grossAmount < MINIMUM_SETTLEMENT_AMOUNT) continue;

      // Calculate fee
      const fee = Math.round(grossAmount * SETTLEMENT_FEE_RATE * 100) / 100;
      const netAmount = grossAmount - fee;

      // Create settlement record
      const settlement = await prisma.settlement.create({
        data: {
          merchantId: merchant.id,
          amount: netAmount,
          token: tokenKey,
          paymentIds: tokenPayments.map((p) => p.id),
          paymentCount: tokenPayments.length,
          fee,
          status: 'PROCESSING',
          fromAddress: FLUXPAY_WALLET,
          toAddress: merchant.walletAddress,
          batchDate: new Date(),
        },
      });

      try {
        const txHash = await transferToMerchant(
          merchant.walletAddress,
          netAmount,
          tokenKey
        );

        await prisma.settlement.update({
          where: { id: settlement.id },
          data: {
            status: 'COMPLETED',
            txHash,
            completedAt: new Date(),
          },
        });

        await prisma.payment.updateMany({
          where: { id: { in: tokenPayments.map((p) => p.id) } },
          data: {
            settled: true,
            settledAt: new Date(),
          },
        });

        settlementsCreated++;
        totalAmount += netAmount;
      } catch (error: any) {
        await prisma.settlement.update({
          where: { id: settlement.id },
          data: {
            status: 'FAILED',
            failureReason: error.message,
            failedAt: new Date(),
          },
        });
        logger.error(
          `[Settlement] Failed for merchant ${merchant.id}, token ${tokenKey}: ${error.message}`
        );
      }
    }
  }

  return {
    merchantCount: merchants.length,
    settlementsCreated,
    totalAmount,
  };
}

// ─── Utility: Group By ──────────────────────────────────────

function groupBy<T extends Record<string, any>>(
  items: T[],
  key: keyof T
): Record<string, T[]> {
  return items.reduce((groups, item) => {
    const value = String(item[key]);
    if (!groups[value]) groups[value] = [];
    groups[value].push(item);
    return groups;
  }, {} as Record<string, T[]>);
}
