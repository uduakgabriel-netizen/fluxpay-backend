import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as refundController from '../controllers/refund.controller';
import { requireAuthOrApiKey } from '../middleware/apikey.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency';

const router = Router();

// ─── Rate Limiters ──────────────────────────────────────────

/** Create/process refunds: 10 per minute per merchant */
const refundWriteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'Too many refund requests. Max 10 per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.merchant?.id || req.ip,
});

/** List/read refunds: 30 per minute per merchant */
const refundReadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many requests. Max 30 per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.merchant?.id || req.ip,
});

// ─── Routes ─────────────────────────────────────────────────

/** POST /api/refunds - Request a new refund */
router.post(
  '/',
  requireAuthOrApiKey as any,
  idempotencyMiddleware as any,
  refundWriteLimiter,
  refundController.createRefund as any
);

/** GET /api/refunds - List refunds with filters */
router.get(
  '/',
  requireAuthOrApiKey as any,
  refundReadLimiter,
  refundController.listRefunds as any
);

/** GET /api/refunds/:id - Get refund details */
router.get(
  '/:id',
  requireAuthOrApiKey as any,
  refundReadLimiter,
  refundController.getRefund as any
);

/** PUT /api/refunds/:id/approve - Approve a pending refund */
router.put(
  '/:id/approve',
  requireAuthOrApiKey as any,
  refundWriteLimiter,
  refundController.approveRefund as any
);

/** PUT /api/refunds/:id/reject - Reject a pending refund */
router.put(
  '/:id/reject',
  requireAuthOrApiKey as any,
  refundWriteLimiter,
  refundController.rejectRefund as any
);

/** POST /api/refunds/:id/process - Process approved refund on-chain */
router.post(
  '/:id/process',
  requireAuthOrApiKey as any,
  idempotencyMiddleware as any,
  refundWriteLimiter,
  refundController.processRefund as any
);

export default router;
