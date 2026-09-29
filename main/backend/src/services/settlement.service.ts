import { logger } from '../utils/logger';
import { PrismaClient, SettlementStatus, Prisma } from '@prisma/client';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ProviderError,
} from '../errors/AppError';
import { transferToMerchant } from '../utils/solana-transfer';
import { getPayoutProvider } from '../providers/provider.factory';
import { retryWithBackoff } from '../utils/retry';
import { maskAccountNumber } from '../utils/encryption';
import { MerchantSettingsService } from './merchantSettings.service';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();

const MINIMUM_SETTLEMENT_AMOUNT = parseFloat(process.env.MIN_SETTLEMENT_AMOUNT || '10');
const SETTLEMENT_FEE_RATE = parseFloat(process.env.SETTLEMENT_FEE_RATE || '0.005'); // 0.5%
const FLUXPAY_WALLET = process.env.FLUXPAY_WALLET_ADDRESS || 'FluxPayMainWallet...';

// In-memory fallback for settlements and test payments
export const memorySettlements = new Map<string, any>();
export const memoryMerchantPayments = new Map<string, any[]>();

// ─── Stage 6: Merchant Fiat Settlement Methods ─────────────────────────

export interface ListMerchantSettlementsQuery {
  status?: string;
  limit?: string | number;
  offset?: string | number;
}

export class SettlementService {
  /**
   * Helper: Add mock completed payment in memory for offline/script tests
   */
  static addMemoryPayment(merchantId: string, payment: any) {
    const list = memoryMerchantPayments.get(merchantId) || [];
    list.push(payment);
    memoryMerchantPayments.set(merchantId, list);
  }

  /**
   * Helper: Find merchant with DB + memory fallback
   */
  static async findMerchant(merchantId: string) {
    let merchant = null;
    try {
      merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
      });
    } catch (err) {
      logger.warn('[Settlement] DB merchant lookup failed, trying memory fallback');
    }

    if (!merchant) {
      merchant = await MerchantSettingsService.findMerchant(merchantId);
    }

    return merchant;
  }

  /**
   * Helper: Find bank account with DB + memory fallback
   */
  static async findBankAccount(accountId: string, merchantId: string) {
    return MerchantSettingsService.findBankAccount(accountId, merchantId);
  }

  /**
   * Helper: Find completed unsettled payments with DB + memory fallback
   */
  static async findUnsettledPayments(merchantId: string) {
    let payments: any[] = [];
    try {
      payments = await prisma.payment.findMany({
        where: {
          merchantId,
          status: 'COMPLETED',
          settled: false,
        },
      });
    } catch (err) {
      logger.warn('[Settlement] DB payments lookup failed, trying memory fallback');
    }

    if (payments.length === 0) {
      const memList = memoryMerchantPayments.get(merchantId) || [];
      payments = memList.filter((p) => p.status === 'COMPLETED' && !p.settled);
    }

    return payments;
  }

  /**
   * Helper: Find settlement with DB + memory fallback
   */
  static async findSettlement(id: string) {
    let settlement = null;
    try {
      settlement = await prisma.settlement.findUnique({
        where: { id },
      });
    } catch (err) {
      logger.warn('[Settlement] DB find settlement failed, trying memory fallback');
    }

    if (!settlement) {
      settlement = memorySettlements.get(id) || null;
    }

    return settlement;
  }

  /**
   * Helper: Update settlement with DB + memory fallback
   */
  static async updateSettlement(id: string, data: any) {
    let updated = null;
    try {
      updated = await prisma.settlement.update({
        where: { id },
        data,
      });
    } catch (err) {
      logger.warn('[Settlement] DB update settlement failed, updating memory fallback');
    }

    const existing = memorySettlements.get(id) || {};
    const merged = { ...existing, ...(updated || {}), ...data, updatedAt: new Date() };
    memorySettlements.set(id, merged);
    return merged;
  }

  /**
   * GET /api/merchant/settlements
   */
  static async listMerchantSettlements(
    merchantId: string,
    query: ListMerchantSettlementsQuery
  ) {
    let limit = 20;
    if (query.limit !== undefined) {
      const parsed = parseInt(String(query.limit), 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 100) {
        throw new ValidationError('Limit must be an integer between 1 and 100');
      }
      limit = parsed;
    }

    let offset = 0;
    if (query.offset !== undefined) {
      const parsed = parseInt(String(query.offset), 10);
      if (isNaN(parsed) || parsed < 0) {
        throw new ValidationError('Offset must be an integer >= 0');
      }
      offset = parsed;
    }

    let settlements: any[] = [];
    let total = 0;

    try {
      const where: Prisma.SettlementWhereInput = { merchantId };
      if (query.status) {
        where.status = query.status as SettlementStatus;
      }

      const [list, count] = await Promise.all([
        prisma.settlement.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
        }),
        prisma.settlement.count({ where }),
      ]);
      settlements = list;
      total = count;
    } catch (err) {
      logger.warn('[Settlement] DB list settlements failed, using memory fallback');
      const all = Array.from(memorySettlements.values()).filter((s) => {
        const matchesMerchant = s.merchantId === merchantId;
        const matchesStatus = query.status ? s.status === query.status : true;
        return matchesMerchant && matchesStatus;
      });
      total = all.length;
      settlements = all.slice(offset, offset + limit);
    }

    return {
      settlements: settlements.map((s) => ({
        id: s.id,
        merchantId: s.merchantId,
        status: s.status,
        currency: s.currency,
        grossAmount: s.grossAmount,
        fiatAmount: s.fiatAmount,
        fxRate: s.fxRate,
        fee: s.fee,
        netAmount: s.netAmount,
        provider: s.provider,
        providerRefId: s.providerRefId,
        bankAccountId: s.bankAccountId,
        paymentCount: Array.isArray(s.paymentIds) ? (s.paymentIds as any[]).length : 0,
        paymentIds: s.paymentIds,
        errorCode: s.errorCode,
        errorMessage: s.errorMessage,
        retryCount: s.retryCount,
        createdAt: s.createdAt instanceof Date ? s.createdAt.toISOString() : s.createdAt,
        updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : s.updatedAt,
        settledAt: s.settledAt
          ? s.settledAt instanceof Date
            ? s.settledAt.toISOString()
            : s.settledAt
          : null,
      })),
      total,
      limit,
      offset,
    };
  }

  /**
   * GET /api/merchant/settlements/:id
   */
  static async getMerchantSettlementById(
    merchantId: string,
    settlementId: string
  ) {
    const settlement = await this.findSettlement(settlementId);

    if (!settlement) {
      throw new NotFoundError('Settlement');
    }

    if (settlement.merchantId !== merchantId) {
      throw new ForbiddenError('Access denied: You do not own this settlement');
    }

    // Fetch associated payments
    const paymentIds: string[] = Array.isArray(settlement.paymentIds)
      ? (settlement.paymentIds as string[])
      : [];

    let payments: any[] = [];
    if (paymentIds.length > 0) {
      try {
        payments = await prisma.payment.findMany({
          where: { id: { in: paymentIds } },
          select: {
            id: true,
            amount: true,
            token: true,
            status: true,
            txHash: true,
            confirmedAt: true,
            settledAt: true,
          },
        });
      } catch (err) {
        const memPayments = memoryMerchantPayments.get(merchantId) || [];
        payments = memPayments.filter((p) => paymentIds.includes(p.id));
      }
    }

    // Fetch bank account details
    let bankAccount = null;
    if (settlement.bankAccountId) {
      const acct = await this.findBankAccount(settlement.bankAccountId, merchantId);
      if (acct) {
        bankAccount = {
          id: acct.id,
          bankName: acct.bankName,
          accountNumber: maskAccountNumber(acct.accountNumber),
          accountName: acct.accountName,
          currency: acct.currency,
          isVerified: acct.isVerified,
        };
      }
    }

    return {
      id: settlement.id,
      merchantId: settlement.merchantId,
      status: settlement.status,
      currency: settlement.currency,
      grossAmount: settlement.grossAmount,
      fiatAmount: settlement.fiatAmount,
      fxRate: settlement.fxRate,
      fee: settlement.fee,
      netAmount: settlement.netAmount,
      provider: settlement.provider,
      providerRefId: settlement.providerRefId,
      bankAccountId: settlement.bankAccountId,
      bankAccount,
      paymentCount: paymentIds.length,
      paymentIds,
      payments,
      errorCode: settlement.errorCode,
      errorMessage: settlement.errorMessage,
      retryCount: settlement.retryCount,
      createdAt:
        settlement.createdAt instanceof Date
          ? settlement.createdAt.toISOString()
          : settlement.createdAt,
      updatedAt:
        settlement.updatedAt instanceof Date
          ? settlement.updatedAt.toISOString()
          : settlement.updatedAt,
      settledAt: settlement.settledAt
        ? settlement.settledAt instanceof Date
          ? settlement.settledAt.toISOString()
          : settlement.settledAt
        : null,
    };
  }

  /**
   * POST /api/merchant/settlements/trigger
   */
  static async triggerSettlement(merchantId: string) {
    // 1. Fetch merchant
    const merchant = await this.findMerchant(merchantId);
    if (!merchant) {
      throw new NotFoundError('Merchant');
    }

    // 2. Check merchant is FIAT
    if (merchant.settlementType !== 'FIAT') {
      throw new ValidationError(
        'Merchant is not configured for FIAT settlement',
        'MERCHANT_NOT_FIAT'
      );
    }

    // 3. Check default payout account exists
    if (!merchant.defaultPayoutAccountId) {
      throw new ValidationError(
        'No default payout account configured',
        'NO_PAYOUT_ACCOUNT'
      );
    }

    const bankAccount = await this.findBankAccount(
      merchant.defaultPayoutAccountId,
      merchantId
    );
    if (!bankAccount || !bankAccount.isVerified) {
      throw new ValidationError(
        'Default payout account is missing or not verified',
        'NO_PAYOUT_ACCOUNT'
      );
    }

    // 4. Gather completed + unsettled payments
    const payments = await this.findUnsettledPayments(merchantId);

    if (payments.length === 0) {
      throw new ValidationError(
        'No payments available to settle',
        'NO_PAYMENTS_TO_SETTLE'
      );
    }

    // 5. Calculate totals + fees
    const grossNum = payments.reduce((sum, p) => sum + p.amount, 0);
    const grossAmount = grossNum.toFixed(2);
    const currency = merchant.settlementCurrency || bankAccount.currency || 'NGN';

    const payoutProvider = getPayoutProvider(currency);
    const quote = await (payoutProvider as any).getFiatQuote({
      cryptoAmount: grossAmount,
      fiatCurrency: currency,
    });

    const fiatAmount = quote.fiatAmount;
    const fxRate = quote.rate;
    const fee = quote.fee;
    const netAmount = (parseFloat(fiatAmount) - parseFloat(fee)).toFixed(2);

    // 6. Create settlement with PENDING
    const settleId = `settle_${randomBytes(8).toString('hex')}`;
    const settleRecord = {
      id: settleId,
      merchantId,
      status: 'PENDING' as SettlementStatus,
      currency,
      grossAmount,
      fiatAmount,
      fxRate,
      fee,
      netAmount,
      provider: (bankAccount as any).provider || (currency === 'NGN' ? 'ngn-mock' : 'usdeur-mock'),
      bankAccountId: bankAccount.id,
      paymentIds: payments.map((p) => p.id),
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      settledAt: null,
      errorCode: null,
      errorMessage: null,
      providerRefId: null,
    };

    let settlement: any = settleRecord;
    try {
      settlement = await prisma.settlement.create({
        data: settleRecord,
      });
    } catch (err) {
      logger.warn('[Settlement] DB create settlement failed, storing in memory fallback');
    }
    memorySettlements.set(settlement.id, { ...settleRecord, ...settlement });

    // 7. Update status to PROCESSING
    await this.updateSettlement(settlement.id, { status: 'PROCESSING' });

    // 8. Call provider adapter with retry
    try {
      const payoutResult = await retryWithBackoff(
        () =>
          payoutProvider.executePayout({
            amount: netAmount,
            currency,
            bankAccountId: bankAccount.id,
            accountNumber: bankAccount.accountNumber,
            bankCode: (bankAccount as any).bankCode || '',
            accountName: bankAccount.accountName,
            reference: settlement.id,
          }),
        { maxAttempts: 3, shouldRetry: (err) => !(err instanceof ValidationError) }
      );

      // On success -> COMPLETED
      const settledAt = new Date();
      const completedSettlement = await this.updateSettlement(settlement.id, {
        status: 'COMPLETED',
        providerRefId: payoutResult.payoutRefId,
        settledAt,
      });

      // Mark payments as settled
      try {
        await prisma.payment.updateMany({
          where: { id: { in: payments.map((p) => p.id) } },
          data: {
            settled: true,
            settledAt,
          },
        });
      } catch (err) {
        // Update memory payments
        for (const p of payments) {
          p.settled = true;
          p.settledAt = settledAt;
        }
      }

      return {
        ...completedSettlement,
        createdAt:
          completedSettlement.createdAt instanceof Date
            ? completedSettlement.createdAt.toISOString()
            : completedSettlement.createdAt,
        updatedAt:
          completedSettlement.updatedAt instanceof Date
            ? completedSettlement.updatedAt.toISOString()
            : completedSettlement.updatedAt,
        settledAt: completedSettlement.settledAt
          ? completedSettlement.settledAt instanceof Date
            ? completedSettlement.settledAt.toISOString()
            : completedSettlement.settledAt
          : null,
      };
    } catch (payoutErr: any) {
      // On failure -> FAILED with error stored
      await this.updateSettlement(settlement.id, {
        status: 'FAILED',
        errorCode: 'PROVIDER_ERROR',
        errorMessage: payoutErr.message || 'Settlement payout failed',
      });

      logger.error('[Settlement] Provider failure during trigger settlement:', {
        settlementId: settlement.id,
        error: payoutErr.message,
      });

      throw new ProviderError(
        payoutErr.message || 'Settlement payout failed',
        (bankAccount as any).provider || 'ngn-mock',
        { settlementId: settlement.id }
      );
    }
  }

  /**
   * Daily Settlement Cron Job (Stage 6)
   */
  static async processDailyFiatSettlement(): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    skipped: number;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let merchants: any[] = [];
    try {
      merchants = await prisma.merchant.findMany({
        where: { settlementType: 'FIAT' },
      });
    } catch (err) {
      logger.warn('[DailyFiatSettlement] DB find merchants failed, checking memory fallback');
      merchants = Array.from(MerchantSettingsService.prototype ? (memorySettlements as any) : []).filter(
        (m: any) => m.settlementType === 'FIAT'
      );
    }

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const merchant of merchants) {
      try {
        // Idempotency: skip if already settled today
        let existingToday = null;
        try {
          existingToday = await prisma.settlement.findFirst({
            where: {
              merchantId: merchant.id,
              status: 'COMPLETED',
              createdAt: { gte: today },
            },
          });
        } catch (err) {
          existingToday = Array.from(memorySettlements.values()).find(
            (s) =>
              s.merchantId === merchant.id &&
              s.status === 'COMPLETED' &&
              new Date(s.createdAt) >= today
          );
        }

        if (existingToday) {
          logger.info(`[DailyFiatSettlement] Merchant ${merchant.id} already settled today. Skipping.`);
          skipped++;
          continue;
        }

        if (!merchant.defaultPayoutAccountId) {
          logger.warn(`[DailyFiatSettlement] Merchant ${merchant.id} has no default payout account.`);
          skipped++;
          continue;
        }

        const bankAccount = await this.findBankAccount(
          merchant.defaultPayoutAccountId,
          merchant.id
        );

        if (!bankAccount || !bankAccount.isVerified) {
          logger.warn(`[DailyFiatSettlement] Merchant ${merchant.id} payout account missing or unverified.`);
          skipped++;
          continue;
        }

        const payments = await this.findUnsettledPayments(merchant.id);

        if (payments.length === 0) {
          skipped++;
          continue;
        }

        processed++;
        const currency = merchant.settlementCurrency || bankAccount.currency || 'NGN';
        const grossNum = payments.reduce((sum, p) => sum + p.amount, 0);
        const grossAmount = grossNum.toFixed(2);

        const payoutProvider = getPayoutProvider(currency);
        const quote = await (payoutProvider as any).getFiatQuote({
          cryptoAmount: grossAmount,
          fiatCurrency: currency,
        });

        const fiatAmount = quote.fiatAmount;
        const fxRate = quote.rate;
        const fee = quote.fee;
        const netAmount = (parseFloat(fiatAmount) - parseFloat(fee)).toFixed(2);

        const settleId = `settle_${randomBytes(8).toString('hex')}`;
        const settleRecord = {
          id: settleId,
          merchantId: merchant.id,
          status: 'PENDING' as SettlementStatus,
          currency,
          grossAmount,
          fiatAmount,
          fxRate,
          fee,
          netAmount,
          provider: (bankAccount as any).provider || (currency === 'NGN' ? 'ngn-mock' : 'usdeur-mock'),
          bankAccountId: bankAccount.id,
          paymentIds: payments.map((p) => p.id),
          retryCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          settledAt: null,
          errorCode: null,
          errorMessage: null,
          providerRefId: null,
        };

        let settlement: any = settleRecord;
        try {
          settlement = await prisma.settlement.create({
            data: settleRecord,
          });
        } catch (err) {
          // Fallback
        }
        memorySettlements.set(settlement.id, { ...settleRecord, ...settlement });

        await this.updateSettlement(settlement.id, { status: 'PROCESSING' });

        try {
          const payoutResult = await retryWithBackoff(
            () =>
              payoutProvider.executePayout({
                amount: netAmount,
                currency,
                bankAccountId: bankAccount.id,
                accountNumber: bankAccount.accountNumber,
                bankCode: (bankAccount as any).bankCode || '',
                accountName: bankAccount.accountName,
                reference: settlement.id,
              }),
            { maxAttempts: 3, shouldRetry: (err) => !(err instanceof ValidationError) }
          );

          const settledAt = new Date();
          await this.updateSettlement(settlement.id, {
            status: 'COMPLETED',
            providerRefId: payoutResult.payoutRefId,
            settledAt,
          });

          try {
            await prisma.payment.updateMany({
              where: { id: { in: payments.map((p) => p.id) } },
              data: { settled: true, settledAt },
            });
          } catch (err) {
            for (const p of payments) {
              p.settled = true;
              p.settledAt = settledAt;
            }
          }

          succeeded++;
        } catch (payoutErr: any) {
          await this.updateSettlement(settlement.id, {
            status: 'FAILED',
            errorCode: 'DAILY_SETTLEMENT_PAYOUT_FAILED',
            errorMessage: payoutErr.message || 'Daily settlement payout failed',
          });
          failed++;
        }
      } catch (merchantErr: any) {
        logger.error(`[DailyFiatSettlement] Error processing merchant ${merchant.id}:`, merchantErr);
        failed++;
      }
    }

    logger.info(
      `[DailyFiatSettlement] Summary: ${processed} processed, ${succeeded} succeeded, ${failed} failed, ${skipped} skipped`
    );

    return { processed, succeeded, failed, skipped };
  }

  /**
   * Settlement Retry Job (Stage 6)
   */
  static async retryFailedSettlements(): Promise<{
    retried: number;
    succeeded: number;
    failed: number;
  }> {
    let failedSettlements: any[] = [];
    try {
      failedSettlements = await prisma.settlement.findMany({
        where: {
          status: 'FAILED',
          retryCount: { lt: 3 },
        },
      });
    } catch (err) {
      failedSettlements = Array.from(memorySettlements.values()).filter(
        (s) => s.status === 'FAILED' && s.retryCount < 3
      );
    }

    let retried = 0;
    let succeeded = 0;
    let failed = 0;

    for (const settlement of failedSettlements) {
      retried++;
      const nextRetryCount = settlement.retryCount + 1;

      await this.updateSettlement(settlement.id, {
        status: 'RETRYING',
        retryCount: nextRetryCount,
      });

      try {
        let bankAccount = null;
        if (settlement.bankAccountId) {
          bankAccount = await this.findBankAccount(
            settlement.bankAccountId,
            settlement.merchantId
          );
        }

        const currency = settlement.currency || 'NGN';
        const payoutProvider = getPayoutProvider(currency);

        const payoutResult = await retryWithBackoff(
          () =>
            payoutProvider.executePayout({
              amount: settlement.netAmount,
              currency,
              bankAccountId: bankAccount?.id,
              accountNumber: bankAccount?.accountNumber || '0000000000',
              bankCode: (bankAccount as any)?.bankCode || '',
              accountName: bankAccount?.accountName,
              reference: settlement.id,
            }),
          { maxAttempts: 3 }
        );

        const settledAt = new Date();
        await this.updateSettlement(settlement.id, {
          status: 'COMPLETED',
          providerRefId: payoutResult.payoutRefId,
          settledAt,
          errorMessage: null,
          errorCode: null,
        });

        const paymentIds: string[] = Array.isArray(settlement.paymentIds)
          ? (settlement.paymentIds as string[])
          : [];
        if (paymentIds.length > 0) {
          try {
            await prisma.payment.updateMany({
              where: { id: { in: paymentIds } },
              data: { settled: true, settledAt },
            });
          } catch (err) {
            // Memory payments update
            const memList = memoryMerchantPayments.get(settlement.merchantId) || [];
            for (const p of memList) {
              if (paymentIds.includes(p.id)) {
                p.settled = true;
                p.settledAt = settledAt;
              }
            }
          }
        }

        succeeded++;
      } catch (err: any) {
        await this.updateSettlement(settlement.id, {
          status: 'FAILED',
          errorMessage: err.message || 'Retry failed',
        });
        failed++;
      }
    }

    return { retried, succeeded, failed };
  }
}

// ─── Legacy Crypto Settlement (Backwards Compatibility) ────────────────

interface ListSettlementsInput {
  merchantId: string;
  page: number;
  limit: number;
  status?: SettlementStatus;
  fromDate?: string;
  toDate?: string;
}

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

  const [settledAgg, pendingAgg] = await Promise.all([
    prisma.settlement.aggregate({
      where: { merchantId, status: 'COMPLETED' },
      _sum: { amount: true },
    }),
    prisma.settlement.aggregate({
      where: {
        merchantId,
        status: { in: ['PROCESSING', 'PENDING'] },
      },
      _sum: { amount: true },
    }),
  ]);

  return {
    data: settlements.map((s) => ({
      ...s,
      batchDate: s.batchDate ? s.batchDate.toISOString() : new Date().toISOString(),
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

export async function getSettlementById(settlementId: string, merchantId: string) {
  const settlement = await prisma.settlement.findFirst({
    where: {
      id: settlementId,
      merchantId,
    },
  });

  if (!settlement) {
    throw new NotFoundError('Settlement');
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
    batchDate: settlement.batchDate ? settlement.batchDate.toISOString() : new Date().toISOString(),
    createdAt: settlement.createdAt.toISOString(),
    completedAt: settlement.completedAt?.toISOString() || null,
    failedAt: settlement.failedAt?.toISOString() || null,
    failureReason: settlement.failureReason,
  };
}

export async function processManualSettlement(merchantId: string, token?: string) {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
  });

  if (!merchant) {
    throw new NotFoundError('Merchant');
  }

  const where: Prisma.PaymentWhereInput = {
    merchantId,
    status: 'COMPLETED',
    settled: false,
  };

  if (token) {
    where.token = token;
  }

  const payments = await prisma.payment.findMany({ where });

  if (payments.length === 0) {
    throw new ValidationError('No unsettled payments found');
  }

  const byToken = groupBy(payments, 'token');
  const results = [];

  for (const [tokenKey, tokenPayments] of Object.entries(byToken)) {
    const totalAmount = tokenPayments.reduce((sum, p) => sum + p.amount, 0);

    if (totalAmount < MINIMUM_SETTLEMENT_AMOUNT) {
      continue;
    }

    const fee = Math.round(totalAmount * SETTLEMENT_FEE_RATE * 100) / 100;
    const netAmount = totalAmount - fee;

    const settlement = await prisma.settlement.create({
      data: {
        merchantId,
        amount: netAmount,
        token: tokenKey,
        currency: tokenKey,
        grossAmount: totalAmount.toString(),
        netAmount: netAmount.toString(),
        paymentIds: tokenPayments.map((p) => p.id),
        paymentCount: tokenPayments.length,
        fee: fee.toString(),
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

      results.push({
        settlementId: settlement.id,
        token: tokenKey,
        amount: netAmount,
        fee,
        txHash,
        status: 'COMPLETED',
      });
    } catch (error: any) {
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
        status: 'FAILED',
        error: error.message,
      });
    }
  }

  return {
    processed: results.length,
    results,
  };
}

export async function processDailySettlement(): Promise<{
  merchantCount: number;
  settlementsCreated: number;
  totalAmount: number;
}> {
  const merchants = await prisma.merchant.findMany();

  let settlementsCreated = 0;
  let totalAmount = 0;

  for (const merchant of merchants) {
    const payments = await prisma.payment.findMany({
      where: {
        merchantId: merchant.id,
        status: 'COMPLETED',
        settled: false,
      },
    });

    if (payments.length === 0) continue;

    const byToken = groupBy(payments, 'token');

    for (const [tokenKey, tokenPayments] of Object.entries(byToken)) {
      const gross = tokenPayments.reduce((sum, p) => sum + p.amount, 0);

      if (gross < MINIMUM_SETTLEMENT_AMOUNT) continue;

      const fee = Math.round(gross * SETTLEMENT_FEE_RATE * 100) / 100;
      const net = gross - fee;

      const settlement = await prisma.settlement.create({
        data: {
          merchantId: merchant.id,
          amount: net,
          token: tokenKey,
          currency: tokenKey,
          grossAmount: gross.toString(),
          netAmount: net.toString(),
          paymentIds: tokenPayments.map((p) => p.id),
          paymentCount: tokenPayments.length,
          fee: fee.toString(),
          status: 'PROCESSING',
          fromAddress: FLUXPAY_WALLET,
          toAddress: merchant.walletAddress,
          batchDate: new Date(),
        },
      });

      try {
        const txHash = await transferToMerchant(
          merchant.walletAddress,
          net,
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
        totalAmount += net;
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
