import { PrismaClient, WebhookLogStatus, Prisma } from '@prisma/client';
import { AppError } from './auth.service';
import { sendTestWebhook } from '../utils/webhook';
import { generateWebhookSecretKey } from '../utils/secrets';

const prisma = new PrismaClient();

// ─── Get Webhook Config ─────────────────────────────────────

export async function getWebhookConfig(merchantId: string) {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: {
      webhookUrl: true,
      webhookSecret: true,
      webhookSecretRotatedAt: true,
    },
  });

  if (!merchant || !merchant.webhookSecret) {
    return {
      configured: false,
      url: merchant?.webhookUrl || null,
      events: ['payment.completed', 'payment.failed', 'payment.expired'], // defaults
      active: !!merchant?.webhookUrl,
      maxRetries: 5,
      secret: null,
    };
  }

  return {
    configured: true,
    url: merchant.webhookUrl,
    events: ['payment.completed', 'payment.failed', 'payment.expired'],
    active: !!merchant.webhookUrl,
    maxRetries: 5,
    retryBackoff: 1000,
    // Show partial secret for display: whsec_abc...xyz
    secretPreview: merchant.webhookSecret.slice(0, 10) + '...' + merchant.webhookSecret.slice(-4),
    updatedAt: merchant.webhookSecretRotatedAt?.toISOString() || new Date().toISOString(),
  };
}

// ─── Update Webhook Config ──────────────────────────────────

interface UpdateWebhookInput {
  merchantId: string;
  url: string;
  events: string[];
  active: boolean;
  maxRetries: number;
}

export async function updateWebhookConfig(input: UpdateWebhookInput) {
  const { merchantId, url } = input;

  const existing = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { webhookSecret: true },
  });

  if (existing?.webhookSecret) {
    // Just update URL
    const updated = await prisma.merchant.update({
      where: { id: merchantId },
      data: { webhookUrl: url },
    });

    return {
      url: updated.webhookUrl,
      events: ['payment.completed', 'payment.failed', 'payment.expired'],
      active: !!updated.webhookUrl,
      maxRetries: 5,
      secretPreview: updated.webhookSecret!.slice(0, 10) + '...' + updated.webhookSecret!.slice(-4),
      updatedAt: updated.webhookSecretRotatedAt?.toISOString() || new Date().toISOString(),
      message: 'Webhook configuration updated.',
    };
  }

  // Create new config with generated secret
  const generated = generateWebhookSecretKey();

  const updated = await prisma.merchant.update({
    where: { id: merchantId },
    data: {
      webhookUrl: url,
      webhookSecret: generated.fullSecret,
      webhookSecretPrefix: generated.prefix,
      webhookSecretLastChars: generated.lastChars,
      webhookSecretRotatedAt: new Date(),
    },
  });

  return {
    url: updated.webhookUrl,
    events: ['payment.completed', 'payment.failed', 'payment.expired'],
    active: !!updated.webhookUrl,
    maxRetries: 5,
    secret: updated.webhookSecret, // Return full secret on creation only
    secretPreview: updated.webhookSecret!.slice(0, 10) + '...' + updated.webhookSecret!.slice(-4),
    createdAt: updated.webhookSecretRotatedAt?.toISOString(),
    message: 'Webhook configured. Store the signing secret securely — it will not be shown in full again.',
  };
}

// ─── Test Webhook ───────────────────────────────────────────

export async function testWebhook(merchantId: string) {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { webhookUrl: true, webhookSecret: true },
  });

  if (!merchant || !merchant.webhookUrl || !merchant.webhookSecret) {
    throw new AppError('No webhook configured. Set up a webhook URL first.', 400);
  }

  const result = await sendTestWebhook(merchantId, merchant.webhookUrl, merchant.webhookSecret);

  return {
    url: merchant.webhookUrl,
    ...result,
    message: result.success
      ? 'Test webhook delivered successfully!'
      : `Test webhook failed: ${result.error}`,
  };
}

// ─── List Webhook Logs ──────────────────────────────────────

interface ListWebhookLogsInput {
  merchantId: string;
  page: number;
  limit: number;
  event?: string;
  status?: WebhookLogStatus;
  fromDate?: string;
  toDate?: string;
}

export async function listWebhookLogs(input: ListWebhookLogsInput) {
  const { merchantId, page, limit, event, status, fromDate, toDate } = input;

  const where: Prisma.WebhookLogWhereInput = { merchantId };

  if (event) where.event = event;
  if (status) where.status = status;

  if (fromDate || toDate) {
    where.createdAt = {};
    if (fromDate) (where.createdAt as any).gte = new Date(fromDate);
    if (toDate) (where.createdAt as any).lte = new Date(toDate);
  }

  const total = await prisma.webhookLog.count({ where });

  const skip = (page - 1) * limit;
  const logs = await prisma.webhookLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip,
    take: limit,
    select: {
      id: true,
      event: true,
      url: true,
      status: true,
      statusCode: true,
      duration: true,
      attempt: true,
      maxAttempts: true,
      error: true,
      createdAt: true,
    },
  });

  const [successCount, failedCount, retryingCount] = await Promise.all([
    prisma.webhookLog.count({ where: { merchantId, status: 'SUCCESS' } }),
    prisma.webhookLog.count({ where: { merchantId, status: 'FAILED' } }),
    prisma.webhookLog.count({ where: { merchantId, status: 'RETRYING' } }),
  ]);

  return {
    data: logs.map((l) => ({
      ...l,
      createdAt: l.createdAt.toISOString(),
    })),
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    summary: {
      successCount,
      failedCount,
      retryingCount,
      successRate: total > 0 ? Math.round((successCount / total) * 100) : 0,
    },
  };
}
