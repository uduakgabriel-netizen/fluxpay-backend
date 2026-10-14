import IORedis from 'ioredis';
import { logger } from '../utils/logger';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

class CacheService {
  private redis: IORedis;
  private hasLoggedError = false;

  constructor() {
    this.redis = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy: () => null,
    });

    this.redis.on('error', (err) => {
      if (!this.hasLoggedError) {
        this.hasLoggedError = true;
        logger.warn('[Cache] Redis unavailable — cache operations will be skipped.');
      }
      // Suppress repeated errors silently
    });
  }

  public async connect() {
    try {
      await this.redis.connect();
    } catch {
      // Ignored
    }
  }

  public async get<T>(key: string): Promise<T | null> {
    try {
      if (this.redis.status !== 'ready') return null;
      const data = await this.redis.get(key);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch (err) {
      logger.error('Redis GET error', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  public async set(key: string, value: any, ttlSeconds: number): Promise<void> {
    try {
      if (this.redis.status !== 'ready') return;
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      logger.error('Redis SET error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  public async invalidate(key: string): Promise<void> {
    try {
      if (this.redis.status !== 'ready') return;
      await this.redis.del(key);
    } catch (err) {
      logger.error('Redis DEL error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Set exclusively if it doesn't exist (useful for idempotency)
  public async setNX(key: string, value: any, ttlSeconds: number): Promise<boolean> {
    try {
      if (this.redis.status !== 'ready') return false; // Fail open or closed? Here let's say false means we couldn't lock.
      const result = await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (err) {
      logger.error('Redis SETNX error', { error: err instanceof Error ? err.message : String(err) });
      return false; // If redis is down, we cannot guarantee idempotency
    }
  }
}

export const cacheService = new CacheService();
