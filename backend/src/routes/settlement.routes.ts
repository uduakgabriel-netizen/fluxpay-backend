import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as settlementController from '../controllers/settlement.controller';
import { requireAuthOrApiKey } from '../middleware/apikey.middleware';

const router = Router();

// ─── Rate Limiters ──────────────────────────────────────────

/** Read settlements: 30 per minute per merchant */
const settlementReadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Max 30 per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.merchant?.id || req.ip,
});

/** Process settlement: 5 per hour per merchant */
const settlementProcessLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many settlement process requests. Max 5 per hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.merchant?.id || req.ip,
});

// ─── Routes ─────────────────────────────────────────────────

/** POST /api/settlements/process - Manual settlement (must be before /:id) */
router.post(
  '/process',
  requireAuthOrApiKey as any,
  settlementProcessLimiter,
  settlementController.processSettlement as any
);

/** GET /api/settlements - List settlements with filters */
router.get(
  '/',
  requireAuthOrApiKey as any,
  settlementReadLimiter,
  settlementController.listSettlements as any
);

/** GET /api/settlements/:id - Get settlement details */
router.get(
  '/:id',
  requireAuthOrApiKey as any,
  settlementReadLimiter,
  settlementController.getSettlement as any
);

export default router;
