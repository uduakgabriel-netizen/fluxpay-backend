import { Request, Response, NextFunction } from 'express';
import { cacheService } from '../services/cache.service';
import { logger } from '../utils/logger';

export const idempotencyMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const idempotencyKey = req.headers['idempotency-key'];

  if (!idempotencyKey) {
    res.status(400).json({ error: 'Idempotency-Key header is required for this endpoint' });
    return;
  }

  if (typeof idempotencyKey !== 'string') {
    res.status(400).json({ error: 'Invalid Idempotency-Key header' });
    return;
  }

  // Create a unique cache key based on the idempotency key, path and merchant (if authenticated)
  // Or just idempotency key and path
  const merchantId = (req as any).merchant?.id || 'anonymous';
  const cacheKey = `idempotency:${merchantId}:${req.method}:${req.path}:${idempotencyKey}`;

  try {
    // Check if we already processed this request
    const cachedResponse = await cacheService.get<{ statusCode: number; body: any }>(cacheKey);

    if (cachedResponse) {
      const reqLogger = (req as any).logger || logger;
      reqLogger.info('Idempotent request detected, returning cached response', { cacheKey });
      res.status(cachedResponse.statusCode).json(cachedResponse.body);
      return;
    }

    // Intercept res.json to cache the response upon successful execution
    const originalJson = res.json.bind(res);
    res.json = (body: any): Response => {
      // Create cache entry only if it was a successful request or acceptable client error
      // 24 hours TTL as requested
      cacheService.set(cacheKey, { statusCode: res.statusCode, body }, 24 * 60 * 60).catch(err => {
        logger.error('Failed to set idempotency cache', { error: err.message });
      });
      return originalJson(body);
    };

    next();
  } catch (error) {
    next(error);
  }
};
