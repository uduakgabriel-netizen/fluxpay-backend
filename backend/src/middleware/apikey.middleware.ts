import { logger } from '../utils/logger';
import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { AuthRequest } from '../types/auth.types';
import { cacheService } from '../services/cache.service';
import { apiKeyToMerchantMap, memorySecrets } from '../services/secret.service';
import { memoryMerchants } from '../services/auth.service';
import { memoryApiKeys } from '../services/apikey.service';

const prisma = new PrismaClient();

/**
 * Helper: extract API key from headers
 * Supports:
 * - x-api-key: sk_live_...
 * - X-API-KEY: sk_live_...
 * - Authorization: Bearer sk_live_...
 * - Authorization: sk_live_...
 */
export function extractApiKey(req: any): string | null {
  const xApiKey = req.headers['x-api-key'] || req.headers['X-API-KEY'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) {
    return xApiKey.trim();
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.trim()) {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      return trimmed.slice(7).trim();
    }
    if (trimmed.startsWith('sk_')) {
      return trimmed;
    }
  }

  return null;
}

/**
 * API Key authentication middleware
 * Verifies API key from header: x-api-key OR Authorization: Bearer sk_live_xxx
 * Rejects revoked keys, tracks usage
 */
export const requireApiKey = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const apiKey = extractApiKey(req);

    if (!apiKey) {
      res.status(401).json({
        error: 'Invalid API key',
      });
      return;
    }

    // Hash the API key to compare with stored hash
    const keyHash = createHash('sha256').update(apiKey).digest('hex');

    const cacheKey = `apikey:${keyHash}`;
    let merchantRecord: any = null;

    try {
      merchantRecord = await cacheService.get(cacheKey);
    } catch {
      // Ignore cache failure
    }

    // 1. Try finding by Merchant.apiKeyHash in database
    if (!merchantRecord) {
      try {
        merchantRecord = await prisma.merchant.findUnique({
          where: { apiKeyHash: keyHash },
        });

        if (merchantRecord) {
          try {
            await cacheService.set(cacheKey, merchantRecord, 60 * 60);
          } catch {}
        }
      } catch (err: any) {
        logger.warn(`[ApiKeyMiddleware] DB merchant lookup by apiKeyHash failed: ${err.message}`);
      }
    }

    // 2. Try finding by ApiKey model in database
    if (!merchantRecord) {
      try {
        const apiKeyRow = await prisma.apiKey.findUnique({
          where: { keyHash },
          include: { merchant: true },
        });

        if (apiKeyRow && !apiKeyRow.revoked) {
          merchantRecord = apiKeyRow.merchant;
          // Async update lastUsed
          prisma.apiKey.update({
            where: { id: apiKeyRow.id },
            data: {
              lastUsed: new Date(),
              requestCount: { increment: 1 },
              lastIp: req.ip || null,
            },
          }).catch(() => {});
        }
      } catch (err: any) {
        logger.warn(`[ApiKeyMiddleware] DB apiKey lookup failed: ${err.message}`);
      }
    }

    // 3. In-memory lookup: check apiKeyToMerchantMap
    if (!merchantRecord) {
      const mapped = apiKeyToMerchantMap.get(keyHash);
      if (mapped) {
        merchantRecord = {
          id: mapped.id,
          walletAddress: mapped.walletAddress,
          email: mapped.email,
          businessName: mapped.businessName,
        };
      }
    }

    // 4. In-memory lookup: search memoryMerchants
    if (!merchantRecord) {
      for (const [id, m] of memoryMerchants.entries()) {
        if (m && m.apiKeyHash === keyHash) {
          merchantRecord = {
            id: m.id || id,
            walletAddress: m.walletAddress || '',
            email: m.email || null,
            businessName: m.businessName || 'FluxPay Merchant',
          };
          break;
        }
      }
    }

    // 5. In-memory lookup: search memorySecrets
    if (!merchantRecord) {
      for (const [id, s] of memorySecrets.entries()) {
        if (s && s.apiKeyHash === keyHash) {
          const memM = memoryMerchants.get(id);
          merchantRecord = {
            id,
            walletAddress: memM?.walletAddress || '',
            email: memM?.email || null,
            businessName: memM?.businessName || 'FluxPay Merchant',
          };
          break;
        }
      }
    }

    // 6. In-memory lookup: search memoryApiKeys
    if (!merchantRecord) {
      for (const k of memoryApiKeys.values()) {
        if (k && k.keyHash === keyHash && !k.revoked) {
          k.lastUsed = new Date();
          k.requestCount += 1;
          const memM = memoryMerchants.get(k.merchantId);
          merchantRecord = {
            id: k.merchantId,
            walletAddress: memM?.walletAddress || '',
            email: memM?.email || null,
            businessName: memM?.businessName || 'FluxPay Merchant',
          };
          break;
        }
      }
    }

    if (!merchantRecord) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    // Attach merchant to request
    req.merchant = {
      id: merchantRecord.id,
      walletAddress: merchantRecord.walletAddress || '',
      email: merchantRecord.email || null,
      businessName: merchantRecord.businessName || 'FluxPay Merchant',
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
  // If request contains an API key (starts with sk_ or in x-api-key), use API key auth
  const extractedKey = extractApiKey(req);
  if (extractedKey && (extractedKey.startsWith('sk_') || req.headers['x-api-key'] || req.headers['X-API-KEY'])) {
    return requireApiKey(req, res, next);
  }

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.trim().toLowerCase().startsWith('bearer ')) {
    const token = authHeader.replace(/^bearer\s+/i, '').trim();
    if (token.startsWith('sk_')) {
      return requireApiKey(req, res, next);
    }
    // Try JWT auth
    const { requireAuth } = await import('./auth.middleware');
    return requireAuth(req, res, next);
  }

  res.status(401).json({
    error: 'No authentication provided. Use header "x-api-key: sk_live_..." or "Authorization: Bearer <token>"',
  });
};
