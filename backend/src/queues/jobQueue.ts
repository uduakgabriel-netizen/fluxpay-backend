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

/**
 * Test if Redis is reachable before attempting to use BullMQ.
 * Returns a connected IORedis instance or null.
 */
async function tryConnectRedis(): Promise<IORedis | null> {
  return new Promise((resolve) => {
    const conn = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 3000,
      retryStrategy: () => null, // Don't retry — we handle fallback
    });

    conn.on('error', () => {}); // Suppress all errors during probe

    conn.connect()
      .then(() => conn.ping())
      .then(() => {
        resolve(conn);
      })
      .catch(() => {
        conn.disconnect();
        resolve(null);
      });
  });
}

/**
 * Initialize cron jobs.
 * Uses BullMQ + Redis if available, otherwise falls back to simple setInterval.
 */
export async function initCronJobs() {
  logger.info('Initializing Cron Jobs...');

  const redisConn = await tryConnectRedis();

  if (redisConn) {
    await initBullMQCronJobs(redisConn);
  } else {
    logger.warn('[CronJobs] Redis unavailable — using in-memory setInterval fallback for cron jobs.');
    initFallbackCronJobs();
  }
}

// ─── BullMQ-based cron jobs (production, with Redis) ────────

async function initBullMQCronJobs(connection: IORedis) {
  cronQueue = new Queue('cron-jobs', { connection });

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

  // Worker connection needs its own IORedis instance
  const workerConn = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  workerConn.on('error', () => {});
  await workerConn.connect();

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
  }, { connection: workerConn });

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
  if (cronWorker) {
    await cronWorker.close();
  }
  if (cronQueue) {
    await cronQueue.close();
  }
}
