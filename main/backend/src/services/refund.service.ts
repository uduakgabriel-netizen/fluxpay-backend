import { PrismaClient, RefundStatus, Prisma } from '@prisma/client';
import { AppError } from './auth.service';
import { processRefundOnChain } from '../utils/solana-transfer';

const prisma = new PrismaClient();

const REFUND_WINDOW_DAYS = parseInt(process.env.REFUND_WINDOW_DAYS || '30', 10);

// ─── Interfaces ─────────────────────────────────────────────

interface CreateRefundInput {
  merchantId: string;
  paymentId: string;
  amount: number;
  reason?: string;
  note?: string;
}

interface ListRefundsInput {
  merchantId: string;
  page: number;
  limit: number;
  status?: RefundStatus;
  fromDate?: string;
  toDate?: string;
}

// ─── Create Refund ──────────────────────────────────────────

export async function createRefund(input: CreateRefundInput) {
  const { merchantId, paymentId, amount, reason, note } = input;

  // 1. Check payment exists and belongs to merchant
  const payment = await prisma.payment.findFirst({
    where: {
      id: paymentId,
      merchantId,
    },
  });

  if (!payment) {
    throw new AppError('Payment not found', 404);
  }

  // 2. Payment must be COMPLETED
  if (payment.status !== 'COMPLETED') {
    throw new AppError('Payment not eligible for refund. Only COMPLETED payments can be refunded.', 400);
  }

  // 3. Validate refund amount does not exceed payment amount
  if (amount > payment.amount) {
    throw new AppError(
      `Refund amount (${amount}) exceeds payment amount (${payment.amount})`,
      400
    );
  }

  // 4. Check time window (configurable, default 30 days)
  const paymentAge = Date.now() - payment.completedAt!.getTime();
  const maxAge = REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  if (paymentAge > maxAge) {
    throw new AppError(
      `Refund window has expired. Refunds must be requested within ${REFUND_WINDOW_DAYS} days of payment completion.`,
      400
    );
  }

  // 5. Check for existing active refund on this payment
  const existingRefund = await prisma.refund.findFirst({
    where: {
      paymentId,
      status: {
        in: ['PENDING', 'APPROVED', 'PROCESSING'],
      },
    },
  });

  if (existingRefund) {
    throw new AppError('A refund has already been requested for this payment', 400);
  }

  // 6. Check if payment was already fully refunded
  if (payment.refunded) {
    throw new AppError('This payment has already been refunded', 400);
  }

  // 7. Create refund record
  const refund = await prisma.refund.create({
    data: {
      merchantId,
      paymentId,
      amount,
      reason: reason || null,
      note: note || null,
      status: 'PENDING',
    },
  });

  return {
    id: refund.id,
    paymentId: refund.paymentId,
    amount: refund.amount,
    reason: refund.reason,
    status: refund.status,
    createdAt: refund.createdAt.toISOString(),
  };
}

// ─── List Refunds ───────────────────────────────────────────

export async function listRefunds(input: ListRefundsInput) {
  const { merchantId, page, limit, status, fromDate, toDate } = input;

  const where: Prisma.RefundWhereInput = { merchantId };

  if (status) {
    where.status = status;
  }

  if (fromDate || toDate) {
    where.createdAt = {};
    if (fromDate) (where.createdAt as any).gte = new Date(fromDate);
    if (toDate) (where.createdAt as any).lte = new Date(toDate);
  }

  // Total count
  const total = await prisma.refund.count({ where });

  // Paginated results
  const skip = (page - 1) * limit;
  const refunds = await prisma.refund.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip,
    take: limit,
    select: {
      id: true,
      paymentId: true,
      amount: true,
      reason: true,
      status: true,
      txHash: true,
      createdAt: true,
      processedAt: true,
    },
  });

  // Summary stats
  const [completedAgg, pendingCount] = await Promise.all([
    prisma.refund.aggregate({
      where: { merchantId, status: 'COMPLETED' },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.refund.count({
      where: { merchantId, status: 'PENDING' },
    }),
  ]);

  return {
    data: refunds.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      completedAt: r.processedAt?.toISOString() || null,
    })),
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    summary: {
      totalRefunded: completedAgg._sum.amount || 0,
      pendingCount,
      completedCount: completedAgg._count,
    },
  };
}

// ─── Get Refund Details ─────────────────────────────────────

export async function getRefundById(refundId: string, merchantId: string) {
  const refund = await prisma.refund.findFirst({
    where: {
      id: refundId,
      merchantId,
    },
    include: {
      payment: {
        select: {
          id: true,
          amount: true,
          token: true,
          status: true,
          customerWallet: true,
          customerEmail: true,
        },
      },
    },
  });

  if (!refund) {
    throw new AppError('Refund not found', 404);
  }

  return {
    id: refund.id,
    paymentId: refund.paymentId,
    amount: refund.amount,
    reason: refund.reason,
    note: refund.note,
    status: refund.status,
    txHash: refund.txHash,
    approvedBy: refund.approvedBy,
    approvedAt: refund.approvedAt?.toISOString() || null,
    rejectedReason: refund.rejectedReason,
    processedAt: refund.processedAt?.toISOString() || null,
    payment: refund.payment,
    createdAt: refund.createdAt.toISOString(),
    updatedAt: refund.updatedAt.toISOString(),
  };
}

// ─── Approve Refund ─────────────────────────────────────────

export async function approveRefund(refundId: string, merchantId: string, approverEmail: string) {
  const refund = await prisma.refund.findFirst({
    where: {
      id: refundId,
      merchantId,
    },
  });

  if (!refund) {
    throw new AppError('Refund not found', 404);
  }

  if (refund.status !== 'PENDING') {
    throw new AppError(`Cannot approve refund with status ${refund.status}. Only PENDING refunds can be approved.`, 400);
  }

  const updated = await prisma.refund.update({
    where: { id: refundId },
    data: {
      status: 'APPROVED',
      approvedBy: approverEmail,
      approvedAt: new Date(),
    },
  });

  return {
    id: updated.id,
    status: updated.status,
    approvedBy: updated.approvedBy,
    approvedAt: updated.approvedAt!.toISOString(),
  };
}

// ─── Reject Refund ──────────────────────────────────────────

export async function rejectRefund(refundId: string, merchantId: string, reason: string) {
  const refund = await prisma.refund.findFirst({
    where: {
      id: refundId,
      merchantId,
    },
  });

  if (!refund) {
    throw new AppError('Refund not found', 404);
  }

  if (refund.status !== 'PENDING') {
    throw new AppError(`Cannot reject refund with status ${refund.status}. Only PENDING refunds can be rejected.`, 400);
  }

  const updated = await prisma.refund.update({
    where: { id: refundId },
    data: {
      status: 'REJECTED',
      rejectedReason: reason,
    },
  });

  return {
    id: updated.id,
    status: updated.status,
    rejectedReason: updated.rejectedReason,
    updatedAt: updated.updatedAt.toISOString(),
  };
}

// ─── Process Refund On-Chain ────────────────────────────────

export async function processRefund(refundId: string, merchantId: string) {
  const refund = await prisma.refund.findFirst({
    where: {
      id: refundId,
      merchantId,
    },
    include: {
      payment: {
        select: {
          customerWallet: true,
          token: true,
        },
      },
    },
  });

  if (!refund) {
    throw new AppError('Refund not found', 404);
  }

  if (refund.status !== 'APPROVED') {
    throw new AppError(
      `Cannot process refund with status ${refund.status}. Only APPROVED refunds can be processed.`,
      400
    );
  }

  // Customer wallet is required for on-chain refund
  const customerWallet = refund.payment.customerWallet;
  if (!customerWallet) {
    throw new AppError(
      'Cannot process refund: no customer wallet address on the original payment.',
      400
    );
  }

  // Mark as PROCESSING
  await prisma.refund.update({
    where: { id: refundId },
    data: { status: 'PROCESSING' },
  });

  try {
    // Execute real on-chain refund from FluxPay hot wallet
    // In non-custodial mode, customer funds went directly to merchant
    // so refunds come from FluxPay's own funds
    const txHash = await processRefundOnChain(
      customerWallet,
      refund.amount,
      refund.payment.token
    );

    // Mark as COMPLETED
    const updated = await prisma.refund.update({
      where: { id: refundId },
      data: {
        status: 'COMPLETED',
        txHash,
        processedAt: new Date(),
      },
    });

    // Mark payment as refunded
    await prisma.payment.update({
      where: { id: refund.paymentId },
      data: {
        refunded: true,
        refundedAt: new Date(),
      },
    });

    return {
      id: updated.id,
      status: updated.status,
      txHash: updated.txHash,
      message: 'Refund successfully processed on Solana',
    };
  } catch (error: any) {
    // Mark as FAILED on error
    await prisma.refund.update({
      where: { id: refundId },
      data: {
        status: 'FAILED',
      },
    });

    throw new AppError(`Refund transaction failed: ${error.message}`, 500);
  }
}
