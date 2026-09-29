import { PrismaClient } from '@prisma/client';
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '../utils/logger';
import { AlertService } from './alert.service';
import { generateWebhookSignature } from '../utils/secrets';

const prisma = new PrismaClient();

const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const MAX_ATTEMPTS = 6;
// Retry backoff delays: Attempt 1: Immediate (0), Attempt 2: 1 min, Attempt 3: 5 min, Attempt 4: 15 min, Attempt 5: 1 hr, Attempt 6: 6 hr
export const RETRY_DELAYS = [0, 60_000, 300_000, 900_000, 3_600_000, 21_600_000];

// In-memory fallback structures
export const inMemoryWebhookLogs: any[] = [];
const inMemoryQueue: Array<{
  id: string;
  data: any;
  nextAttemptTime: number;
  attempt: number;
  timer?: NodeJS.Timeout;
}> = [];

// Track failures for rate alerting (5+ failures in 10 min)
const recentFailureTimestamps: number[] = [];

function recordFailureAndCheckAlert(): void {
  const now = Date.now();
  recentFailureTimestamps.push(now);
  const tenMinutesAgo = now - 10 * 60 * 1000;
  // Prune older than 10 mins
  while (recentFailureTimestamps.length > 0 && recentFailureTimestamps[0] < tenMinutesAgo) {
    recentFailureTimestamps.shift();
  }
  if (recentFailureTimestamps.length >= 5) {
    AlertService.alertHighWebhookFailureRate(recentFailureTimestamps.length, 10).catch(() => {});
  }
}

export interface EnqueueWebhookInput {
  merchantId?: string;
  event: string;
  data: Record<string, any>;
  url?: string;
  secret?: string;
}

export class WebhookQueueService {
  private static redisConnection: IORedis | null = null;
  private static webhookQueue: Queue | null = null;
  private static webhookWorker: Worker | null = null;
  private static useRedis = false;
  private static initialized = false;

  public static async init(): Promise<void> {
    if (this.initialized) return;

    try {
      this.redisConnection = new IORedis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
        retryStrategy: () => null,
      });

      this.redisConnection.on('error', () => {
        // Silently handled - fallback to in-memory
      });

      await this.redisConnection.connect();
      logger.info('[WebhookQueue] Connected to Redis for persistent webhook queue');

      this.webhookQueue = new Queue('webhook-delivery-queue', {
        connection: this.redisConnection,
        defaultJobOptions: {
          attempts: MAX_ATTEMPTS,
          backoff: {
            type: 'custom',
          },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        },
      });

      const workerConnection = new IORedis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
        retryStrategy: () => null,
      });
      workerConnection.on('error', () => {});
      await workerConnection.connect();

      this.webhookWorker = new Worker(
        'webhook-delivery-queue',
        async (job: Job) => {
          await WebhookQueueService.processJob(job);
        },
        {
          connection: workerConnection,
          concurrency: 5,
          settings: {
            backoffStrategy: (attemptsMade: number) => {
              return RETRY_DELAYS[attemptsMade] || 21_600_000;
            },
          },
        }
      );

      this.webhookWorker.on('completed', (job) => {
        logger.info(`[WebhookQueue] Job ${job.id} completed successfully`);
      });

      this.webhookWorker.on('failed', (job, err) => {
        logger.error(`[WebhookQueue] Job ${job?.id} failed attempt ${job?.attemptsMade}:`, err.message);
      });

      this.useRedis = true;
      this.initialized = true;
    } catch (err: any) {
      logger.warn(`[WebhookQueue] Redis unavailable (${err.message}). Using in-memory fallback queue.`);
      this.useRedis = false;
      this.initialized = true;
    }
  }

  public static async shutdown(): Promise<void> {
    if (this.webhookWorker) {
      await this.webhookWorker.close();
    }
    if (this.webhookQueue) {
      await this.webhookQueue.close();
    }
    if (this.redisConnection) {
      this.redisConnection.disconnect();
    }
    // Clear in-memory timers
    for (const item of inMemoryQueue) {
      if (item.timer) clearTimeout(item.timer);
    }
    inMemoryQueue.length = 0;
    this.initialized = false;
  }

  /**
   * Enqueue a webhook for delivery to a merchant.
   */
  public static async enqueue(input: EnqueueWebhookInput): Promise<{ logId: string; queued: boolean }> {
    await this.init();

    let targetUrl = input.url;
    let targetSecret = input.secret;

    if (!targetUrl && input.merchantId) {
      try {
        const merchant = await prisma.merchant.findUnique({
          where: { id: input.merchantId },
          select: { webhookUrl: true, webhookSecret: true },
        });
        targetUrl = merchant?.webhookUrl || undefined;
        targetSecret = merchant?.webhookSecret || undefined;
      } catch {
        // DB fallback
      }
    }

    if (!targetUrl) {
      logger.warn(`[WebhookQueue] No webhook URL found for merchant ${input.merchantId}. Skipping enqueue.`);
      return { logId: '', queued: false };
    }

    const payload = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      event: input.event,
      data: input.data,
      timestamp: new Date().toISOString(),
      merchantId: input.merchantId,
    };
    const payloadStr = JSON.stringify(payload);
    const signature = targetSecret ? generateWebhookSignature(payloadStr, targetSecret).signature : '';

    // Create log record
    let logId = `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const logData = {
      merchantId: input.merchantId || null,
      event: input.event,
      url: targetUrl,
      payload,
      status: 'PENDING' as const,
      attempt: 1,
      maxAttempts: MAX_ATTEMPTS,
      nextRetryAt: new Date(Date.now() + RETRY_DELAYS[0]),
    };

    try {
      const created = await prisma.webhookLog.create({
        data: logData as any,
      });
      logId = created.id;
    } catch {
      inMemoryWebhookLogs.push({ id: logId, ...logData, createdAt: new Date() });
    }

    const jobData = {
      logId,
      merchantId: input.merchantId,
      url: targetUrl,
      payloadStr,
      signature,
      event: input.event,
    };

    if (this.useRedis && this.webhookQueue) {
      await this.webhookQueue.add('deliver', jobData, {
        jobId: `webhook_${logId}`,
        attempts: MAX_ATTEMPTS,
      });
    } else {
      // In-memory queue
      this.scheduleInMemoryDelivery(jobData, 1);
    }

    return { logId, queued: true };
  }

  /**
   * BullMQ processor
   */
  private static async processJob(job: Job): Promise<void> {
    const { logId, merchantId, url, payloadStr, signature, event } = job.data;
    const attempt = job.attemptsMade + 1;
    await this.deliverRequest({ logId, merchantId, url, payloadStr, signature, event, attempt });
  }

  /**
   * Schedules next delivery attempt in-memory when Redis is unavailable.
   */
  private static scheduleInMemoryDelivery(jobData: any, attempt: number): void {
    const delay = RETRY_DELAYS[attempt - 1] !== undefined ? RETRY_DELAYS[attempt - 1] : 21_600_000;

    const timer = setTimeout(async () => {
      try {
        await WebhookQueueService.deliverRequest({
          ...jobData,
          attempt,
        });
      } catch (err: any) {
        if (attempt < MAX_ATTEMPTS) {
          WebhookQueueService.scheduleInMemoryDelivery(jobData, attempt + 1);
        }
      }
    }, delay);

    inMemoryQueue.push({
      id: jobData.logId,
      data: jobData,
      nextAttemptTime: Date.now() + delay,
      attempt,
      timer,
    });
  }

  /**
   * Executes HTTP POST delivery to the destination webhook URL.
   */
  public static async deliverRequest(opts: {
    logId: string;
    merchantId?: string;
    url: string;
    payloadStr: string;
    signature: string;
    event: string;
    attempt: number;
  }): Promise<void> {
    const { logId, merchantId, url, payloadStr, signature, event, attempt } = opts;
    const startTime = Date.now();
    const isFinal = attempt >= MAX_ATTEMPTS;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-FluxPay-Event': event,
        'User-Agent': 'FluxPay-Webhook/1.0',
      };
      if (signature) {
        headers['X-FluxPay-Signature'] = signature;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: payloadStr,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      let responseBody = '';
      try {
        responseBody = (await response.text()).slice(0, 500);
      } catch {
        responseBody = '';
      }

      if (response.ok) {
        // Success
        await this.updateLog(logId, {
          status: 'SUCCESS',
          statusCode: response.status,
          responseBody,
          duration,
          attempt,
        });
        return;
      }

      // Non-2xx
      recordFailureAndCheckAlert();
      const nextDelay = attempt < MAX_ATTEMPTS ? RETRY_DELAYS[attempt] : null;
      const nextRetryAt = nextDelay ? new Date(Date.now() + nextDelay) : null;

      await this.updateLog(logId, {
        status: isFinal ? 'FAILED' : 'RETRYING',
        statusCode: response.status,
        responseBody,
        duration,
        attempt,
        nextRetryAt,
        error: `HTTP ${response.status}: ${response.statusText}`,
      });

      if (isFinal) {
        logger.error(`[WebhookQueue] Delivery permanently failed after ${attempt} attempts for log ${logId}`);
        if (merchantId) {
          await AlertService.alertWebhookFailure(merchantId, event, url, attempt);
        }
        return;
      }

      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorMessage = error.name === 'AbortError' ? `Timeout after ${WEBHOOK_TIMEOUT_MS}ms` : error.message;

      recordFailureAndCheckAlert();
      const nextDelay = attempt < MAX_ATTEMPTS ? RETRY_DELAYS[attempt] : null;
      const nextRetryAt = nextDelay ? new Date(Date.now() + nextDelay) : null;

      await this.updateLog(logId, {
        status: isFinal ? 'FAILED' : 'RETRYING',
        duration,
        attempt,
        nextRetryAt,
        error: errorMessage,
      });

      if (isFinal) {
        logger.error(`[WebhookQueue] Webhook permanently failed after ${attempt} attempts: ${errorMessage}`);
        if (merchantId) {
          await AlertService.alertWebhookFailure(merchantId, event, url, attempt);
        }
        return;
      }

      throw error;
    }
  }

  private static async updateLog(logId: string, data: any): Promise<void> {
    try {
      await prisma.webhookLog.update({
        where: { id: logId },
        data,
      });
    } catch {
      // Memory fallback update
      const existing = inMemoryWebhookLogs.find((l) => l.id === logId);
      if (existing) {
        Object.assign(existing, data);
      }
    }
  }

  public static getRecentFailuresCount(): number {
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    return recentFailureTimestamps.filter((t) => t >= tenMinutesAgo).length;
  }

  public static isUsingRedis(): boolean {
    return this.useRedis;
  }
}
