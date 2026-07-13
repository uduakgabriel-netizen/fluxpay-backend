import { logger } from '../utils/logger';
import { PrismaClient, PaymentStatus, Prisma } from '@prisma/client';
import { AppError } from './auth.service';
import { getNonCustodialQuote } from './nonCustodialSwap.service';

const prisma = new PrismaClient();
const PAYMENT_EXPIRY_HOURS = 24;
const CHECKOUT_BASE_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const QUOTE_EXPIRY_SECONDS = 60; // Jupiter quotes expire after 60 seconds

// ─── Interfaces ─────────────────────────────────────────────

interface CreatePaymentInput {
  merchantId: string;
  amount: number;
  token: string;
  customerEmail?: string;
  customerWallet?: string;
  metadata?: Record<string, any>;
}

interface ListPaymentsInput {
  merchantId: string;
  page: number;
  limit: number;
  status?: PaymentStatus;
  token?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
}

// ─── Helper: Get and Store Swap Quote ────────────────────

async function getAndStoreSwapQuote(
  paymentId: string,
  fromToken: string,
  toToken: string,
  amount: number
) {
  try {
    const quote = await getNonCustodialQuote(fromToken, toToken, amount);
    
    if (!quote) {
      logger.error(`[Payment] Failed to get swap quote for payment ${paymentId}`);
      return null;
    }

    // Store the quote with 60-second expiry
    const expiresAt = new Date(Date.now() + QUOTE_EXPIRY_SECONDS * 1000);

    const swapQuote = await prisma.swapQuote.create({
      data: {
        paymentId,
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        inputAmount: quote.inAmount,
        expectedOutput: quote.outAmount,
        minOutputAmount: quote.otherAmountThreshold || '0',
        quote: quote as any,
        slippageBps: quote.slippageBps,
        expiresAt,
      },
    });

    return {
      quote: swapQuote,
      expired: false,
    };
  } catch (error) {
    logger.error('[Payment] Error getting swap quote:', error);
    return null;
  }
}

// ─── Helper: Get Valid Swap Quote (with refresh if needed) ──

export async function getValidSwapQuote(paymentId: string) {
  try {
    let swapQuote = await prisma.swapQuote.findUnique({
      where: { paymentId },
    });

    if (!swapQuote) {
      return null;
    }

    const isExpired = new Date() > swapQuote.expiresAt;
    
    if (isExpired) {
      // Quote expired, need to refresh
      logger.info(`[Payment] Swap quote expired for payment ${paymentId}, refreshing...`);

      // Get payment details to get tokens and amount
      const payment = await prisma.payment.findUnique({
        where: { id: paymentId },
      });

      if (!payment || !payment.swappedFrom) {
        return null;
      }

      // Delete old quote
      await prisma.swapQuote.delete({
        where: { paymentId },
      });

      // Get fresh quote
      const newQuote = await getAndStoreSwapQuote(
        paymentId,
        payment.swappedFrom,
        payment.token,
        payment.amount
      );

      if (!newQuote) {
        return null;
      }

      swapQuote = newQuote.quote;
    }

    return swapQuote;
  } catch (error) {
    logger.error('[Payment] Error getting valid swap quote:', error);
    return null;
  }
}

// ─── Helper: Check and Alert on Price Impact ────────────

export async function checkPriceImpact(paymentId: string): Promise<{
  hasPriceChange: boolean;
  priceChangePercent: number;
  requiresConfirmation: boolean;
}> {
  try {
    const swapQuote = await prisma.swapQuote.findUnique({
      where: { paymentId },
    });

    if (!swapQuote) {
      return { hasPriceChange: false, priceChangePercent: 0, requiresConfirmation: false };
    }

    const quote = swapQuote.quote as any;
    const priceImpactPercent = parseFloat(quote.priceImpactPct || '0');

    // If price impact > 5%, require user confirmation
    return {
      hasPriceChange: priceImpactPercent > 0,
      priceChangePercent: priceImpactPercent,
      requiresConfirmation: priceImpactPercent > 5,
    };
  } catch (error) {
    logger.error('[Payment] Error checking price impact:', error);
    return { hasPriceChange: false, priceChangePercent: 0, requiresConfirmation: false };
  }
}

// ─── Create Payment (Non-Custodial) ─────────────────────────

export async function createPayment(input: CreatePaymentInput) {
  const { merchantId, amount, token, customerEmail, customerWallet, metadata } = input;

  // Fetch merchant and their preferred token
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: {
      id: true,
      preferredTokenMint: true,
      preferredTokenSymbol: true,
      preferredTokenDecimals: true,
      walletAddress: true,
    },
  });

  if (!merchant) {
    throw new AppError('Merchant not found', 404);
  }

  // Set expiry to 24 hours from now
  const expiresAt = new Date(Date.now() + PAYMENT_EXPIRY_HOURS * 60 * 60 * 1000);

  const customerTokenSymbol = token.toUpperCase();
  const merchantPreferredToken = merchant.preferredTokenSymbol;
  
  // Determine if swap is needed
  const swapNeeded = customerTokenSymbol !== merchantPreferredToken;

  // NON-CUSTODIAL: No deposit wallet creation.
  // Payment intent is created, customer will pay directly from their wallet.
  const paymentData: Prisma.PaymentCreateInput = {
    merchant: {
      connect: { id: merchantId }
    },
    amount,
    token: merchantPreferredToken, // Store settlement token, not customer's token
    customerEmail: customerEmail || null,
    customerWallet: customerWallet || null,
    metadata: metadata || Prisma.JsonNull,
    status: 'PENDING',
    // Non-custodial: store merchant wallet directly
    merchantWallet: merchant.walletAddress,
    // No receivingAddress or privateKey needed — non-custodial
    expiresAt,
    swapRequired: swapNeeded,
    swappedFrom: swapNeeded ? customerTokenSymbol : null,
  };

  const payment = await prisma.payment.create({
    data: paymentData,
  });

  // Create initial status event
  await prisma.paymentEvent.create({
    data: {
      paymentId: payment.id,
      status: 'PENDING',
    },
  });

  // Get swap quote if swap is needed
  let swapQuoteInfo = null;
  if (swapNeeded) {
    swapQuoteInfo = await getAndStoreSwapQuote(
      payment.id,
      customerTokenSymbol,
      merchantPreferredToken,
      amount
    );
  }

  return {
    id: payment.id,
    amount: payment.amount,
    settlementToken: payment.token, // Token merchant will receive
    customerPaymentToken: customerTokenSymbol, // Token customer is paying with
    status: payment.status,
    merchantWallet: merchant.walletAddress, // Customer pays directly to merchant
    checkoutUrl: `${CHECKOUT_BASE_URL}/pay/${payment.id}`,
    swapRequired: swapNeeded,
    swapQuote: swapQuoteInfo?.quote || null,
    expiresAt: payment.expiresAt.toISOString(),
    createdAt: payment.createdAt.toISOString(),
  };
}

// ─── List Payments ──────────────────────────────────────────

export async function listPayments(input: ListPaymentsInput) {
  const { merchantId, page, limit, status, token, fromDate, toDate, search } = input;

  // Build where clause
  const where: Prisma.PaymentWhereInput = {
    merchantId,
  };

  if (status) {
    where.status = status;
  }

  if (token) {
    where.token = token.toUpperCase();
  }

  if (fromDate || toDate) {
    where.createdAt = {};
    if (fromDate) {
      (where.createdAt as any).gte = new Date(fromDate);
    }
    if (toDate) {
      (where.createdAt as any).lte = new Date(toDate);
    }
  }

  if (search) {
    where.OR = [
      { id: { contains: search, mode: 'insensitive' } },
      { customerWallet: { contains: search, mode: 'insensitive' } },
      { customerEmail: { contains: search, mode: 'insensitive' } },
      { txHash: { contains: search, mode: 'insensitive' } },
    ];
  }

  // Get total count
  const total = await prisma.payment.count({ where });

  // Get paginated results
  const skip = (page - 1) * limit;
  const payments = await prisma.payment.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip,
    take: limit,
    select: {
      id: true,
      amount: true,
      token: true,
      status: true,
      customerWallet: true,
      customerEmail: true,
      txHash: true,
      merchantWallet: true,
      createdAt: true,
      completedAt: true,
    },
  });

  // Calculate summary (for the filtered set)
  const summaryAgg = await prisma.payment.aggregate({
    where,
    _sum: { amount: true },
    _count: true,
    _avg: { amount: true },
  });

  return {
    data: payments.map((p) => ({
      ...p,
      createdAt: p.createdAt.toISOString(),
      completedAt: p.completedAt?.toISOString() || null,
    })),
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    summary: {
      totalAmount: summaryAgg._sum.amount || 0,
      totalPayments: summaryAgg._count,
      averageAmount: Math.round((summaryAgg._avg.amount || 0) * 100) / 100,
    },
  };
}

// ─── Get Payment Details ────────────────────────────────────

export async function getPaymentById(paymentId: string, merchantId: string) {
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      merchantId,
    },
    include: {
      statusHistory: {
        orderBy: { timestamp: 'asc' },
      },
      refunds: true,
    },
  });

  if (!payment) {
    throw new AppError('Payment not found', 404);
  }

  // Get swap quote if swap was required
  let swapQuoteInfo = null;
  if (payment.swapRequired) {
    const swapQuote = await getValidSwapQuote(paymentId);
    swapQuoteInfo = swapQuote ? {
      inputMint: swapQuote.inputMint,
      outputMint: swapQuote.outputMint,
      inputAmount: swapQuote.inputAmount,
      expectedOutput: swapQuote.expectedOutput,
      minOutputAmount: swapQuote.minOutputAmount,
      slippageBps: swapQuote.slippageBps,
      expiresAt: swapQuote.expiresAt.toISOString(),
    } : null;
  }

  // Build swap details if applicable
  const swapDetails = payment.swapRequired
    ? {
        required: true,
        fromToken: payment.swappedFrom,
        fromAmount: payment.amount,
        toToken: payment.token,
        toAmount: payment.swappedAmount,
        fee: payment.swapFee ?? (payment.amount - (payment.swappedAmount || 0)),
        swapTxHash: payment.swapTxHash,
        retries: payment.swapRetries,
        lastError: payment.lastSwapError,
        quote: swapQuoteInfo,
      }
    : null;

  // Build timeline from status history
  const timeline = payment.statusHistory.map((event) => ({
    status: event.status,
    timestamp: event.timestamp.toISOString(),
  }));

  return {
    id: payment.id,
    amount: payment.amount,
    settlementToken: payment.token,
    customerPaymentToken: payment.swappedFrom || payment.token,
    status: payment.status,
    customerWallet: payment.customerWallet,
    customerEmail: payment.customerEmail,
    merchantWallet: payment.merchantWallet,
    txHash: payment.txHash,
    metadata: payment.metadata,
    swapDetails,
    timeline,
    refunds: payment.refunds.map((r) => ({
      id: r.id,
      amount: r.amount,
      reason: r.reason,
      status: r.status,
      txHash: r.txHash,
      createdAt: r.createdAt.toISOString(),
    })),
    confirmedAt: payment.confirmedAt?.toISOString() || null,
    createdAt: payment.createdAt.toISOString(),
    completedAt: payment.completedAt?.toISOString() || null,
    expiresAt: payment.expiresAt.toISOString(),
  };
}

// ─── Get Payment Status ─────────────────────────────────────

export async function getPaymentStatus(paymentId: string, merchantId: string) {
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      merchantId,
    },
    select: {
      id: true,
      status: true,
      amount: true,
      token: true,
      customerWallet: true,
      merchantWallet: true,
      txHash: true,
      completedAt: true,
    },
  });

  if (!payment) {
    throw new AppError('Payment not found', 404);
  }

  return {
    ...payment,
    completedAt: payment.completedAt?.toISOString() || null,
  };
}

// ─── Retry Failed Payment ───────────────────────────────────

export async function retryPayment(paymentId: string, merchantId: string) {
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      merchantId,
    },
    include: {
      merchant: true,
    },
  });

  if (!payment) {
    throw new AppError('Payment not found', 404);
  }

  if (payment.status !== 'FAILED') {
    throw new AppError('Only FAILED payments can be retried', 400);
  }

  if (!payment.customerWallet) {
    throw new AppError('Cannot retry: no customer wallet on this payment', 400);
  }

  // Reset payment status for retry
  await prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: 'PENDING',
      swapRetries: 0,
      lastSwapError: null,
      adminAlertSent: false,
    },
  });

  await prisma.paymentEvent.create({
    data: {
      paymentId,
      status: 'PENDING',
    },
  });

  return {
    id: payment.id,
    status: 'PENDING',
    message: 'Payment has been reset for retry. Customer will need to approve the transaction again.',
  };
}

// ─── Export Payments to CSV ─────────────────────────────────

export async function exportPayments(
  merchantId: string,
  filters: {
    fromDate?: string;
    toDate?: string;
    status?: PaymentStatus;
    token?: string;
  }
): Promise<string> {
  const where: Prisma.PaymentWhereInput = { merchantId };

  if (filters.status) where.status = filters.status;
  if (filters.token) where.token = filters.token.toUpperCase();

  if (filters.fromDate || filters.toDate) {
    where.createdAt = {};
    if (filters.fromDate) (where.createdAt as any).gte = new Date(filters.fromDate);
    if (filters.toDate) (where.createdAt as any).lte = new Date(filters.toDate);
  }

  const payments = await prisma.payment.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  // Build CSV
  const headers = [
    'Payment ID',
    'Amount',
    'Token',
    'Status',
    'Customer Wallet',
    'Customer Email',
    'Merchant Wallet',
    'Transaction Hash',
    'Swap Tx Hash',
    'Created At',
    'Completed At',
  ];

  const rows = payments.map((p) =>
    [
      p.id,
      p.amount.toString(),
      p.token,
      p.status,
      p.customerWallet || '',
      p.customerEmail || '',
      p.merchantWallet || '',
      p.txHash || '',
      p.swapTxHash || '',
      p.createdAt.toISOString(),
      p.completedAt?.toISOString() || '',
    ]
      .map((field) => `"${field}"`)
      .join(',')
  );

  return [headers.join(','), ...rows].join('\n');
}

// ─── Expire Pending Payments ────────────────────────────────

export async function expirePendingPayments(): Promise<number> {
  const result = await prisma.payment.updateMany({
    where: {
      status: 'PENDING',
      expiresAt: { lt: new Date() },
    },
    data: {
      status: 'EXPIRED',
    },
  });

  // Create status events for expired payments
  if (result.count > 0) {
    const expired = await prisma.payment.findMany({
      where: {
        status: 'EXPIRED',
        statusHistory: {
          none: { status: 'EXPIRED' },
        },
      },
      select: { id: true },
    });

    if (expired.length > 0) {
      await prisma.paymentEvent.createMany({
        data: expired.map((p) => ({
          paymentId: p.id,
          status: 'EXPIRED' as PaymentStatus,
        })),
      });
    }
  }

  return result.count;
}

// ─── Dashboard Stats ────────────────────────────────────────

export async function getPaymentStats(merchantId: string) {
  // Total revenue (completed payments)
  const revenueAgg = await prisma.payment.aggregate({
    where: { merchantId, status: 'COMPLETED' },
    _sum: { amount: true },
    _count: true,
  });

  // Total transactions
  const totalTxCount = await prisma.payment.count({ where: { merchantId } });

  // Success rate
  const completedCount = revenueAgg._count;
  const failedCount = await prisma.payment.count({ where: { merchantId, status: 'FAILED' } });
  const finishedCount = completedCount + failedCount;
  const successRate = finishedCount > 0 ? Math.round((completedCount / finishedCount) * 1000) / 10 : 100;

  // Token distribution (by completed payments)
  const tokenGroups = await prisma.payment.groupBy({
    by: ['token'],
    where: { merchantId, status: 'COMPLETED' },
    _sum: { amount: true },
    _count: true,
  });

  const totalTokenAmount = tokenGroups.reduce((s, g) => s + (g._sum.amount || 0), 0);
  const tokenDistribution = tokenGroups.map((g) => ({
    token: g.token,
    amount: g._sum.amount || 0,
    count: g._count,
    percentage: totalTokenAmount > 0 ? Math.round(((g._sum.amount || 0) / totalTokenAmount) * 100) : 0,
  }));

  // Daily revenue for last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentPayments = await prisma.payment.findMany({
    where: {
      merchantId,
      status: 'COMPLETED',
      completedAt: { gte: thirtyDaysAgo },
    },
    select: { amount: true, completedAt: true },
    orderBy: { completedAt: 'asc' },
  });

  // Group by date
  const dailyRevenueMap = new Map<string, number>();
  for (let d = 0; d < 30; d++) {
    const date = new Date(Date.now() - (29 - d) * 24 * 60 * 60 * 1000);
    dailyRevenueMap.set(date.toISOString().split('T')[0], 0);
  }
  for (const p of recentPayments) {
    if (p.completedAt) {
      const dateKey = p.completedAt.toISOString().split('T')[0];
      dailyRevenueMap.set(dateKey, (dailyRevenueMap.get(dateKey) || 0) + p.amount);
    }
  }
  const dailyRevenue = Array.from(dailyRevenueMap.entries()).map(([date, amount]) => ({ date, amount }));

  // Recent 5 transactions
  const recentTransactions = await prisma.payment.findMany({
    where: { merchantId },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      amount: true,
      token: true,
      status: true,
      customerWallet: true,
      createdAt: true,
    },
  });

  return {
    totalRevenue: revenueAgg._sum.amount || 0,
    totalTransactions: totalTxCount,
    completedTransactions: completedCount,
    successRate,
    tokenDistribution,
    dailyRevenue,
    recentTransactions: recentTransactions.map((t) => ({
      id: t.id,
      amount: t.amount,
      token: t.token,
      status: t.status,
      customerWallet: t.customerWallet,
      createdAt: t.createdAt.toISOString(),
    })),
  };
}
