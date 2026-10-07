/**
 * Checkout Routes
 *
 * POST   /api/checkout/sessions              — Create session (requires API key)
 * GET    /api/checkout/sessions/:id           — Get session details (public)
 * GET    /api/checkout/sessions/:id/status    — Poll status (public)
 * POST   /api/checkout/sessions/:id/execute   — Execute payment (public)
 * POST   /api/checkout/sessions/:id/confirm   — Confirm tx hash (public)
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as checkoutController from '../controllers/checkout.controller';
import { requireApiKey, requireAuthOrApiKey } from '../middleware/apikey.middleware';

const router = Router();

// Rate limiters
const createSessionLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  message: { error: 'Too many checkout session requests. Max 20 per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.merchant?.id || req.ip,
});

const publicLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please try again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Routes ─────────────────────────────────────────────────

/** POST /api/checkout/sessions — Create checkout session (API key required) */
router.post(
  '/sessions',
  requireAuthOrApiKey as any,
  createSessionLimiter,
  checkoutController.createSession as any
);

/** GET /api/checkout/sessions/:id — Get session details (public, no auth) */
router.get(
  '/sessions/:id',
  publicLimiter,
  checkoutController.getSession as any
);

/** GET /api/checkout/sessions/:id/status — Poll status (public, no auth) */
router.get(
  '/sessions/:id/status',
  publicLimiter,
  checkoutController.getSessionStatus as any
);

/** POST /api/checkout/sessions/:id/execute — Execute payment (public, no auth) */
router.post(
  '/sessions/:id/execute',
  publicLimiter,
  checkoutController.executePayment as any
);

/** POST /api/checkout/sessions/:id/confirm — Confirm transaction (public, no auth) */
router.post(
  '/sessions/:id/confirm',
  publicLimiter,
  checkoutController.confirmPayment as any
);

export default router;
