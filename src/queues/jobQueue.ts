import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '../utils/logger';
import { runExpirePayments } from '../jobs/expire-payments';
import { refreshTokens } from '../jobs/refresh-tokens';
import { checkWalletBalance } from '../jobs/checkWalletBalance';
import { checkMerchantBalances } from '../jobs/checkMerchantBalance';
// import { monitorSwapFailureRate } from '../jobs/monitorSwapFailureRate';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Lazy-initialized — NOT created at module load time
let cronQueue: Queue | null = null;
let cronWorker: Worker | null = null;
let fallbackTimers: NodeJS.Timeout[] = [];

export function getBullMQConnection() {
  const isTls = REDIS_URL.startsWith('rediss://') || REDIS_URL.includes('upstash.io');
  try {
    const parsed = new URL(REDIS_URL);
    return {
      host: parsed.hostname,
      port: Number(parsed.port) || 6379,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      tls: isTls ? {} : undefined,
      maxRetriesPerRequest: null,
      connectTimeout: 15000,
      retryStrategy: (times: number) => (times <= 3 ? Math.min(times * 500, 2000) : null),
    };
  } catch {
    return {
      host: '127.0.0.1',
      port: 6379,
      maxRetriesPerRequest: null,
    };
  }
}

/**
 * Test if Redis is reachable before attempting to use BullMQ.
 * Returns true or false.
 */
async function isRedisReachable(): Promise<boolean> {
  const isTls = REDIS_URL.startsWith('rediss://') || REDIS_URL.includes('upstash.io');
  return new Promise((resolve) => {
    const conn = new IORedis(REDIS_URL, {
      tls: isTls ? {} : undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 8000,
      retryStrategy: () => null,
    });

    conn.on('error', () => {}); // Suppress all errors during probe

    conn.connect()
      .then(() => conn.ping())
      .then(() => {
        conn.disconnect();
        resolve(true);
      })
      .catch(() => {
        conn.disconnect();
        resolve(false);
      });
  });
}

/**
 * Initialize cron jobs.
 * Uses BullMQ + Redis if available, otherwise falls back to simple setInterval.
 */
export async function initCronJobs() {
  logger.info('Initializing Cron Jobs...');

  const reachable = await isRedisReachable();

  if (reachable) {
    await initBullMQCronJobs();
  } else {
    logger.warn('[CronJobs] Redis unavailable — using in-memory setInterval fallback for cron jobs.');
    initFallbackCronJobs();
  }
}

// ─── BullMQ-based cron jobs (production, with Redis) ────────

async function initBullMQCronJobs() {
  const connection = getBullMQConnection();
  cronQueue = new Queue('cron-jobs', { connection });
  cronQueue.on('error', (err) => {
    logger.warn(`[CronQueue] Queue Redis error: ${err.message}`);
  });

  // expire-payments: Every hour
  await cronQueue.add('expire-payments', {}, {
    repeat: { pattern: '0 * * * *' },
  });

  // refresh-tokens: Every 24 hours
  await cronQueue.add('refresh-tokens', {}, {
    repeat: { pattern: '0 0 * * *' },
  });

  // checkWalletBalance: Every hour
  await cronQueue.add('checkWalletBalance', {}, {
    repeat: { pattern: '0 * * * *' },
  });

  // checkMerchantBalance: Every 4 hours
  await cronQueue.add('checkMerchantBalance', {}, {
    repeat: { pattern: '0 */4 * * *' },
  });

  // monitorSwapFailureRate: Every hour
  await cronQueue.add('monitorSwapFailureRate', {}, {
    repeat: { pattern: '0 * * * *' },
  });

  cronWorker = new Worker('cron-jobs', async (job: Job) => {
    logger.info(`Starting cron job: ${job.name}`);
    try {
      switch (job.name) {
        case 'expire-payments':
          await runExpirePayments();
          break;
        case 'refresh-tokens':
          await refreshTokens();
          break;
        case 'checkWalletBalance':
          await checkWalletBalance();
          break;
        case 'checkMerchantBalance':
          await checkMerchantBalances();
          break;
        case 'monitorSwapFailureRate':
          // await monitorSwapFailureRate();
          logger.info('Running swap failure monitoring');
          break;
        default:
          logger.warn(`Unknown job name: ${job.name}`);
      }
      logger.info(`Successfully completed cron job: ${job.name}`);
    } catch (error) {
      logger.error(`Error in cron job ${job.name}`, { error: error instanceof Error ? error.message : String(error) });
      throw error; // Let BullMQ handle retry/failure logging
    }
  }, { connection });

  cronWorker.on('error', (err) => {
    logger.warn(`[CronWorker] Worker Redis error: ${err.message}`);
  });

  cronWorker.on('failed', (job, err) => {
    logger.error(`Job ${job?.name} failed with error`, { error: err.message, jobId: job?.id });
  });

  logger.info('[CronJobs] BullMQ cron jobs ready (Redis-backed)');
}

// ─── Fallback: setInterval-based cron jobs (no Redis) ───────

function initFallbackCronJobs() {
  const ONE_HOUR = 60 * 60 * 1000;
  const FOUR_HOURS = 4 * ONE_HOUR;
  const TWENTY_FOUR_HOURS = 24 * ONE_HOUR;

  const safeRun = async (name: string, fn: () => Promise<void>) => {
    try {
      logger.info(`[Fallback] Starting cron job: ${name}`);
      await fn();
      logger.info(`[Fallback] Completed cron job: ${name}`);
    } catch (error) {
      logger.error(`[Fallback] Error in cron job ${name}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  fallbackTimers.push(
    setInterval(() => safeRun('expire-payments', runExpirePayments), ONE_HOUR),
    setInterval(() => safeRun('refresh-tokens', refreshTokens), TWENTY_FOUR_HOURS),
    setInterval(() => safeRun('checkWalletBalance', checkWalletBalance), ONE_HOUR),
    setInterval(() => safeRun('checkMerchantBalance', checkMerchantBalances), FOUR_HOURS),
  );

  logger.info('[CronJobs] In-memory fallback cron jobs ready');
}

/**
 * Graceful shutdown for cron jobs.
 */
export async function shutdownCronJobs() {
  // Clear fallback timers
  for (const timer of fallbackTimers) {
    clearInterval(timer);
  }
  fallbackTimers = [];

  // Shutdown BullMQ
  try {
    if (cronWorker) {
      await cronWorker.close().catch(() => {});
      cronWorker = null;
    }
  } catch {}

  try {
    if (cronQueue) {
      await cronQueue.close().catch(() => {});
      cronQueue = null;
    }
  } catch {}
}
