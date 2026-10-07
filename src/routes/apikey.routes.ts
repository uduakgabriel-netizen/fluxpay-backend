import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as apikeyController from '../controllers/apikey.controller';
import { requireAuthOrApiKey } from '../middleware/apikey.middleware';

const router = Router();

// ─── Rate Limiters ──────────────────────────────────────────

/** Key management: 10 per minute */
const keyWriteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { error: 'Too many API key operations. Max 10 per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.merchant?.id || req.ip,
});

/** Read operations: 30 per minute */
const keyReadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Max 30 per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.merchant?.id || req.ip,
});

// ─── Routes ─────────────────────────────────────────────────

/** GET /api/api-keys - List all API keys */
router.get(
  '/',
  requireAuthOrApiKey as any,
  keyReadLimiter,
  apikeyController.listApiKeys as any
);

/** POST /api/api-keys - Create a new API key */
router.post(
  '/',
  requireAuthOrApiKey as any,
  keyWriteLimiter,
  apikeyController.createApiKey as any
);

/** GET /api/api-keys/:id/stats - Get usage stats */
router.get(
  '/:id/stats',
  requireAuthOrApiKey as any,
  keyReadLimiter,
  apikeyController.getApiKeyStats as any
);

/** DELETE /api/api-keys/:id - Revoke an API key */
router.delete(
  '/:id',
  requireAuthOrApiKey as any,
  keyWriteLimiter,
  apikeyController.revokeApiKey as any
);

export default router;
