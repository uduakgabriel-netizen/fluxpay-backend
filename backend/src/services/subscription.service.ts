import { PrismaClient } from '@prisma/client';
import { AppError } from './auth.service';

const prisma = new PrismaClient();

export interface CreateSubscriptionInput {
  customer: string;
  customerEmail: string;
  plan: string;
  amount: number;
  token?: string;
  interval?: 'MONTHLY' | 'YEARLY';
}

export interface SubscriptionFilters {
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
}

/**
 * List subscriptions for a merchant
 */
export async function listSubscriptions(merchantId: string, filters: SubscriptionFilters) {
  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;

  const where: any = { merchantId };
  if (filters.status) where.status = filters.status;
  if (filters.search) {
    where.OR = [
      { customer: { contains: filters.search, mode: 'insensitive' } },
      { customerEmail: { contains: filters.search, mode: 'insensitive' } },
      { plan: { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  const [subscriptions, total] = await Promise.all([
    prisma.subscription.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.subscription.count({ where }),
  ]);

  // Stats
  const allSubs = await prisma.subscription.findMany({ where: { merchantId } });
  const activeSubs = allSubs.filter(s => s.status === 'ACTIVE');
  const mrr = activeSubs
    .filter(s => s.interval === 'MONTHLY')
    .reduce((sum, s) => sum + s.amount, 0);
  const totalCustomers = new Set(allSubs.map(s => s.customer)).size;

  return {
    data: subscriptions.map(sub => ({
      id: sub.id,
      customer: sub.customer,
      customerEmail: sub.customerEmail,
      plan: sub.plan,
      amount: sub.amount,
      token: sub.token,
      interval: sub.interval,
      status: sub.status,
      nextBillingDate: sub.nextBillingDate.toISOString(),
      lastBilledAt: sub.lastBilledAt?.toISOString() || null,
      cancelledAt: sub.cancelledAt?.toISOString() || null,
      createdAt: sub.createdAt.toISOString(),
    })),
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    stats: {
      activeCount: activeSubs.length,
      mrr,
      totalCustomers,
    },
  };
}

/**
 * Create a new subscription
 */
export async function createSubscription(merchantId: string, input: CreateSubscriptionInput) {
  const nextBillingDate = new Date();
  if (input.interval === 'YEARLY') {
    nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
  } else {
    nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
  }

  const subscription = await prisma.subscription.create({
    data: {
      merchantId,
      customer: input.customer,
      customerEmail: input.customerEmail,
      plan: input.plan,
      amount: input.amount,
      token: input.token || 'USDC',
      interval: input.interval || 'MONTHLY',
      nextBillingDate,
    },
  });

  return {
    id: subscription.id,
    customer: subscription.customer,
    plan: subscription.plan,
    status: subscription.status,
    createdAt: subscription.createdAt.toISOString(),
  };
}

/**
 * Update subscription status (pause, resume, cancel)
 */
export async function updateSubscriptionStatus(
  merchantId: string,
  subscriptionId: string,
  action: 'pause' | 'resume' | 'cancel'
) {
  const sub = await prisma.subscription.findFirst({
    where: { id: subscriptionId, merchantId },
  });

  if (!sub) throw new AppError('Subscription not found', 404);

  let updateData: any = {};
  switch (action) {
    case 'pause':
      if (sub.status !== 'ACTIVE') throw new AppError('Only active subscriptions can be paused', 400);
      updateData = { status: 'PAUSED' };
      break;
    case 'resume':
      if (sub.status !== 'PAUSED') throw new AppError('Only paused subscriptions can be resumed', 400);
      updateData = { status: 'ACTIVE' };
      break;
    case 'cancel':
      if (sub.status === 'CANCELLED') throw new AppError('Subscription already cancelled', 400);
      updateData = { status: 'CANCELLED', cancelledAt: new Date() };
      break;
  }

  const updated = await prisma.subscription.update({
    where: { id: subscriptionId },
    data: updateData,
  });

  return {
    id: updated.id,
    status: updated.status,
  };
}
