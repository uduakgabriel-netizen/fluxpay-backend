import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as paymentController from '../controllers/payment.controller';
import { requireApiKey, requireAuthOrApiKey } from '../middleware/apikey.middleware';
import { idempotencyMiddleware } from '../middleware/idempotency';

const router = Router();

// ─── Rate Limiters ──────────────────────────────────────────

/** Create payments: 10 per minute per merchant */
const createPaymentLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'Too many payment creation requests. Max 10 per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.merchant?.id || req.ip,
});

/** List/read payments: 30 per minute per merchant */
const listPaymentLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Too many requests. Max 30 per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.merchant?.id || req.ip,
});

/** Export: 5 per hour per merchant */
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Too many export requests. Max 5 per hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.merchant?.id || req.ip,
});

// ─── Routes ─────────────────────────────────────────────────

// All payment routes require API key or JWT auth
// Note: export route must come BEFORE /:id to avoid "export" being treated as an ID

/** POST /api/payments - Create a new payment session */
router.post(
  '/',
  requireAuthOrApiKey as any,
  idempotencyMiddleware as any,
  createPaymentLimiter,
  paymentController.createPayment as any
);

/** GET /api/payments/export - Export payments to CSV */
router.get(
  '/export',
  requireAuthOrApiKey as any,
  exportLimiter,
  paymentController.exportPayments as any
);

/** GET /api/payments - List payments with filters */
router.get(
  '/',
  requireAuthOrApiKey as any,
  listPaymentLimiter,
  paymentController.listPayments as any
);

/** GET /api/payments/stats - Dashboard overview stats */
router.get(
  '/stats',
  requireAuthOrApiKey as any,
  listPaymentLimiter,
  paymentController.getStats as any
);

/** GET /api/payments/:id/status - Check payment status */
router.get(
  '/:id/status',
  requireAuthOrApiKey as any,
  listPaymentLimiter,
  paymentController.getPaymentStatus as any
);

/** POST /api/payments/:id/retry - Retry a failed payment swap */
router.post(
  '/:id/retry',
  requireAuthOrApiKey as any,
  idempotencyMiddleware as any,
  createPaymentLimiter,
  paymentController.retryPayment as any
);

/** GET /api/payments/:id - Get full payment details */
router.get(
  '/:id',
  requireAuthOrApiKey as any,
  listPaymentLimiter,
  paymentController.getPayment as any
);

export default router;
