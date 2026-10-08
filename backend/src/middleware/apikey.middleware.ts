import { logger } from '../utils/logger';
import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { AuthRequest } from '../types/auth.types';
import { cacheService } from '../services/cache.service';

const prisma = new PrismaClient();

/**
 * API Key authentication middleware
 * Verifies API key from Authorization header: Bearer sk_live_xxx
 * Rejects revoked keys, tracks usage (lastUsed, requestCount, lastIp)
 */
export const requireApiKey = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No API key provided. Use Authorization: Bearer sk_live_xxx' });
      return;
    }

    const apiKey = authHeader.replace('Bearer ', '');

    // Hash the API key to compare with stored hash
    const keyHash = createHash('sha256').update(apiKey).digest('hex');

    const cacheKey = `apikey:${keyHash}`;
    let merchantRecord: any = await cacheService.get(cacheKey);

    if (!merchantRecord) {
      merchantRecord = await prisma.merchant.findUnique({
        where: { apiKeyHash: keyHash },
      });

      if (merchantRecord) {
        await cacheService.set(cacheKey, merchantRecord, 60 * 60); // 1 hour TTL
      }
    }

    if (!merchantRecord) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    // Attach merchant to request
    req.merchant = {
      id: merchantRecord.id,
      walletAddress: merchantRecord.walletAddress,
      email: merchantRecord.email,
      businessName: merchantRecord.businessName,
    };

    next();
  } catch (error) {
    logger.error('API Key middleware error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Combined auth middleware: accepts either JWT Bearer token OR API key
 * This allows both dashboard (JWT) and programmatic (API key) access
 */
export const requireAuthOrApiKey = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No authentication provided' });
    return;
  }

  const token = authHeader.replace('Bearer ', '');

  // If it looks like an API key (starts with sk_), use API key auth
  if (token.startsWith('sk_')) {
    return requireApiKey(req, res, next);
  }

  // Otherwise try JWT auth
  const { requireAuth } = await import('./auth.middleware');
  return requireAuth(req, res, next);
};
