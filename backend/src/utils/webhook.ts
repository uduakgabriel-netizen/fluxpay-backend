import { logger } from '../utils/logger';
/**
 * Webhook Delivery Utility — PRODUCTION
 *
 * Handles delivering webhooks to merchant endpoints with:
 * - HMAC-SHA256 signature generation (X-FluxPay-Signature)
 * - Persistent retry queue via BullMQ + Redis
 * - Exponential backoff: 1min → 5min → 15min → 1hr → 6hr
 * - Delivery logging to database
 * - Survives server restarts (jobs persist in Redis)
 *
 * Falls back to in-memory retry if Redis is unavailable.
 */

import { PrismaClient } from '@prisma/client';
import { createHmac } from 'crypto';
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { AlertService } from '../services/alert.service';
import { cacheService } from '../services/cache.service';

const prisma = new PrismaClient();

const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10);
const MAX_RESPONSE_BODY_LENGTH = 500; // Truncate stored response bodies
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// ─── Redis & BullMQ Setup ───────────────────────────────────

let redisConnection: IORedis | null = null;
let webhookQueue: Queue | null = null;
let webhookWorker: Worker | null = null;
let useRedis = false;

/**
 * Initialize the BullMQ webhook queue.
 * Call this on server startup.
 */
export async function initWebhookQueue(): Promise<void> {
  try {
    redisConnection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy: () => null, // Don't auto-retry — we handle fallback
    });

    // Attach error handler BEFORE connecting to prevent unhandled error events
    redisConnection.on('error', (err) => {
      // Silently handled — fallback to in-memory mode
    });

    await redisConnection.connect();
    logger.info('[Webhook] Connected to Redis for persistent queue');

    webhookQueue = new Queue('webhook-delivery', {
      connection: redisConnection,
      defaultJobOptions: {
        // Retry backoff: 1min, 5min, 15min, 1hr, 6hr
        attempts: 5,
        backoff: {
          type: 'custom',
        },
        removeOnComplete: { count: 1000 }, // Keep last 1000 completed
        removeOnFail: { count: 5000 },     // Keep last 5000 failed
      },
    });

    // Create the worker that processes webhook deliveries
    const workerConnection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy: () => null,
    });

    workerConnection.on('error', () => {});
    await workerConnection.connect();

    webhookWorker = new Worker(
      'webhook-delivery',
      async (job: Job) => {
        await processWebhookJob(job);
      },
      {
        connection: workerConnection,
        concurrency: 5, // Process up to 5 webhooks concurrently
        settings: {
          backoffStrategy: (attemptsMade: number) => {
            // Custom backoff: 1min, 5min, 15min, 1hr, 6hr
            const delays = [60_000, 300_000, 900_000, 3_600_000, 21_600_000];
            return delays[attemptsMade - 1] || 21_600_000;
          },
        },
      }
    );

    webhookWorker.on('completed', (job) => {
      logger.info(`[Webhook] Job ${job.id} completed`);
    });

    webhookWorker.on('failed', (job, err) => {
      logger.error(`[Webhook] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
    });

    useRedis = true;
    logger.info('[Webhook] BullMQ queue and worker initialized');
  } catch (error: any) {
    logger.warn(`[Webhook] Redis unavailable (${error.message}). Using in-memory fallback.`);
    useRedis = false;
  }
}

/**
 * Gracefully shutdown the webhook queue.
 * Call this on server shutdown.
 */
export async function shutdownWebhookQueue(): Promise<void> {
  if (webhookWorker) {
    await webhookWorker.close();
    logger.info('[Webhook] Worker shut down');
  }
  if (webhookQueue) {
    await webhookQueue.close();
    logger.info('[Webhook] Queue shut down');
  }
  if (redisConnection) {
    redisConnection.disconnect();
    logger.info('[Webhook] Redis disconnected');
  }
}

// ─── Webhook Delivery ───────────────────────────────────────

interface DeliverWebhookInput {
  merchantId: string;
  event: string;
  data: Record<string, any>;
}

import { generateWebhookSignature } from './secrets';

export async function deliverWebhook(input: DeliverWebhookInput): Promise<void> {
  const { merchantId, event, data } = input;

  try {
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { webhookUrl: true, webhookSecret: true },
    });

    if (!merchant || !merchant.webhookUrl || !merchant.webhookSecret) {
      return; // Merchant hasn't configured webhooks
    }

    // Build payload
    const payload = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      event,
      data,
      timestamp: new Date().toISOString(),
      merchantId,
    };

    const payloadStr = JSON.stringify(payload);

    // Generate Stripe-style signature
    const { signature } = generateWebhookSignature(payloadStr, merchant.webhookSecret);
    const maxRetries = 5;

    // Create log entry
    const log = await prisma.webhookLog.create({
      data: {
        merchantId,
        event,
        url: merchant.webhookUrl,
        payload,
        status: 'PENDING',
        attempt: 1,
        maxAttempts: maxRetries,
      },
    });

    if (useRedis && webhookQueue) {
      // Enqueue in BullMQ for persistent delivery
      await webhookQueue.add(
        'deliver',
        {
          logId: log.id,
          url: merchant.webhookUrl,
          payloadStr,
          signature,
          event,
          maxAttempts: maxRetries,
        },
        {
          jobId: `webhook_${log.id}`,
          attempts: maxRetries,
        }
      );
    } else {
      // Fallback: in-memory delivery with retry
      attemptDeliveryInMemory(log.id, merchant.webhookUrl, payloadStr, signature, 1, maxRetries, 1000)
        .catch((err) => logger.error(`[Webhook] Delivery error for log ${log.id}:`, err));
    }
  } catch (error) {
    logger.error(`[Webhook] Error delivering ${event} for merchant ${merchantId}:`, error);
  }
}

// ─── BullMQ Job Processor ───────────────────────────────────

/**
 * Process a webhook delivery job from BullMQ.
 * Throws on failure to trigger BullMQ's built-in retry.
 */
async function processWebhookJob(job: Job): Promise<void> {
  const { logId, url, payloadStr, signature, event } = job.data;
  const attempt = job.attemptsMade + 1;

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FluxPay-Signature': signature,
        'X-FluxPay-Event': event,
        'User-Agent': 'FluxPay-Webhook/1.0',
      },
      body: payloadStr,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const duration = Date.now() - startTime;
    let responseBody = '';

    try {
      responseBody = await response.text();
      if (responseBody.length > MAX_RESPONSE_BODY_LENGTH) {
        responseBody = responseBody.slice(0, MAX_RESPONSE_BODY_LENGTH) + '... (truncated)';
      }
    } catch {
      responseBody = '(unable to read response body)';
    }

    if (response.ok) {
      // Success — update log
      await prisma.webhookLog.update({
        where: { id: logId },
        data: {
          status: 'SUCCESS',
          statusCode: response.status,
          responseBody,
          duration,
          attempt,
        },
      });
      return; // Job complete
    }

    // Non-2xx — update log and throw to trigger retry
    await prisma.webhookLog.update({
      where: { id: logId },
      data: {
        status: 'RETRYING',
        statusCode: response.status,
        responseBody,
        duration,
        attempt,
        error: `HTTP ${response.status}: ${response.statusText}`,
      },
    });

    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  } catch (error: any) {
    const duration = Date.now() - startTime;
    const errorMessage = error.name === 'AbortError'
      ? `Timeout after ${WEBHOOK_TIMEOUT_MS}ms`
      : error.message || 'Unknown error';

    // Check if this is the last attempt
    const maxAttempts = job.opts.attempts || 5;
    const isFinal = attempt >= maxAttempts;

    await prisma.webhookLog.update({
      where: { id: logId },
      data: {
        status: isFinal ? 'FAILED' : 'RETRYING',
        duration,
        attempt,
        error: errorMessage,
      },
    });

    if (isFinal) {
      logger.error(`[Webhook] Delivery permanently failed after ${attempt} attempts for log ${logId}`);
      
      const log = await prisma.webhookLog.findUnique({ where: { id: logId } });
      if (log) {
        AlertService.alertWebhookFailure(log.merchantId, log.event, log.url, attempt).catch(logger.error);
      }
      
      return; // Don't throw — BullMQ will mark it as completed
    }

    // Throw to trigger BullMQ retry with backoff
    throw new Error(errorMessage);
  }
}

// ─── In-Memory Fallback ─────────────────────────────────────

/**
 * Attempt to deliver a webhook with in-memory retry (fallback when Redis is unavailable).
 */
async function attemptDeliveryInMemory(
  logId: string,
  url: string,
  payloadStr: string,
  signature: string,
  attempt: number,
  maxAttempts: number,
  retryBackoffMs: number
): Promise<void> {
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FluxPay-Signature': signature,
        'X-FluxPay-Event': (await prisma.webhookLog.findUnique({ where: { id: logId } }))?.event || '',
        'User-Agent': 'FluxPay-Webhook/1.0',
      },
      body: payloadStr,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const duration = Date.now() - startTime;
    let responseBody = '';

    try {
      responseBody = await response.text();
      if (responseBody.length > MAX_RESPONSE_BODY_LENGTH) {
        responseBody = responseBody.slice(0, MAX_RESPONSE_BODY_LENGTH) + '... (truncated)';
      }
    } catch {
      responseBody = '(unable to read response body)';
    }

    if (response.ok) {
      // Success
      await prisma.webhookLog.update({
        where: { id: logId },
        data: {
          status: 'SUCCESS',
          statusCode: response.status,
          responseBody,
          duration,
          attempt,
        },
      });
    } else {
      // Non-2xx response — retry
      await handleInMemoryRetry(logId, url, payloadStr, signature, attempt, maxAttempts, retryBackoffMs, {
        statusCode: response.status,
        responseBody,
        duration,
        error: `HTTP ${response.status}: ${response.statusText}`,
      });
    }
  } catch (error: any) {
    const duration = Date.now() - startTime;
    const errorMessage = error.name === 'AbortError'
      ? `Timeout after ${WEBHOOK_TIMEOUT_MS}ms`
      : error.message || 'Unknown error';

    await handleInMemoryRetry(logId, url, payloadStr, signature, attempt, maxAttempts, retryBackoffMs, {
      statusCode: null,
      responseBody: null,
      duration,
      error: errorMessage,
    });
  }
}

/**
 * Handle retry logic with exponential backoff (in-memory fallback)
 */
async function handleInMemoryRetry(
  logId: string,
  url: string,
  payloadStr: string,
  signature: string,
  attempt: number,
  maxAttempts: number,
  retryBackoffMs: number,
  result: {
    statusCode: number | null;
    responseBody: string | null;
    duration: number;
    error: string;
  }
): Promise<void> {
  if (attempt >= maxAttempts) {
    // Final failure
    await prisma.webhookLog.update({
      where: { id: logId },
      data: {
        status: 'FAILED',
        statusCode: result.statusCode,
        responseBody: result.responseBody,
        duration: result.duration,
        attempt,
        error: result.error,
      },
    });
    logger.info(`[Webhook] Delivery failed after ${attempt} attempts for log ${logId}`);
    
    const log = await prisma.webhookLog.findUnique({ where: { id: logId } });
    if (log) {
      AlertService.alertWebhookFailure(log.merchantId, log.event, log.url, attempt).catch(logger.error);
    }
    
    return;
  }

  // Calculate exponential backoff: base * 2^(attempt-1)
  const backoffMs = retryBackoffMs * Math.pow(2, attempt - 1);
  const nextRetryAt = new Date(Date.now() + backoffMs);

  // Update log as RETRYING
  await prisma.webhookLog.update({
    where: { id: logId },
    data: {
      status: 'RETRYING',
      statusCode: result.statusCode,
      responseBody: result.responseBody,
      duration: result.duration,
      attempt,
      error: result.error,
      nextRetryAt,
    },
  });

  logger.info(
    `[Webhook] Retry ${attempt + 1}/${maxAttempts} for log ${logId} in ${backoffMs}ms`
  );

  // Schedule retry
  setTimeout(() => {
    attemptDeliveryInMemory(logId, url, payloadStr, signature, attempt + 1, maxAttempts, retryBackoffMs)
      .catch((err) => logger.error(`[Webhook] Retry error for log ${logId}:`, err));
  }, backoffMs);
}

// ─── Test Webhook Delivery ──────────────────────────────────

/**
 * Send a test webhook to verify the merchant's endpoint
 */
export async function sendTestWebhook(
  merchantId: string,
  url: string,
  secret: string
): Promise<{
  success: boolean;
  statusCode?: number;
  responseBody?: string;
  duration: number;
  error?: string;
}> {
  const payload = {
    id: `evt_test_${Date.now()}`,
    event: 'test.webhook',
    data: {
      message: 'This is a test webhook from FluxPay',
      timestamp: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
    merchantId,
  };

  const payloadStr = JSON.stringify(payload);
  const { signature } = generateWebhookSignature(payloadStr, secret);

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-FluxPay-Signature': signature,
        'X-FluxPay-Event': 'test.webhook',
        'User-Agent': 'FluxPay-Webhook/1.0',
      },
      body: payloadStr,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const duration = Date.now() - startTime;
    let responseBody = '';
    try {
      responseBody = await response.text();
      if (responseBody.length > MAX_RESPONSE_BODY_LENGTH) {
        responseBody = responseBody.slice(0, MAX_RESPONSE_BODY_LENGTH) + '... (truncated)';
      }
    } catch {
      responseBody = '';
    }

    // Log the test delivery
    await prisma.webhookLog.create({
      data: {
        merchantId,
        event: 'test.webhook',
        url,
        payload,
        status: response.ok ? 'SUCCESS' : 'FAILED',
        statusCode: response.status,
        responseBody,
        duration,
        attempt: 1,
        maxAttempts: 1,
        error: response.ok ? null : `HTTP ${response.status}`,
      },
    });

    return {
      success: response.ok,
      statusCode: response.status,
      responseBody,
      duration,
      error: response.ok ? undefined : `HTTP ${response.status}: ${response.statusText}`,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    const errorMessage = error.name === 'AbortError'
      ? `Timeout after ${WEBHOOK_TIMEOUT_MS}ms`
      : error.message || 'Unknown error';

    // Log failed test
    await prisma.webhookLog.create({
      data: {
        merchantId,
        event: 'test.webhook',
        url,
        payload,
        status: 'FAILED',
        duration,
        attempt: 1,
        maxAttempts: 1,
        error: errorMessage,
      },
    });

    return {
      success: false,
      duration,
      error: errorMessage,
    };
  }
}
