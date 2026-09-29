import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as webhookController from '../controllers/webhook.controller';
import { requireAuthOrApiKey } from '../middleware/apikey.middleware';

const router = Router();

// ─── Rate Limiters ──────────────────────────────────────────

/** Config updates: 10 per minute */
const webhookWriteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { error: 'Too many webhook config updates. Max 10 per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.merchant?.id || req.ip,
});

/** Read operations: 30 per minute */
const webhookReadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Max 30 per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.merchant?.id || req.ip,
});

/** Test webhook: 5 per minute (prevent abuse) */
const webhookTestLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  message: { error: 'Too many test requests. Max 5 per minute.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.merchant?.id || req.ip,
});

// ─── Routes ─────────────────────────────────────────────────

// Static routes MUST come before parameterised routes

/** POST /api/webhooks/test - Send test webhook */
router.post(
  '/test',
  requireAuthOrApiKey as any,
  webhookTestLimiter,
  webhookController.testWebhook as any
);

/** GET /api/webhooks/logs - List webhook delivery logs */
router.get(
  '/logs',
  requireAuthOrApiKey as any,
  webhookReadLimiter,
  webhookController.listWebhookLogs as any
);

/** GET /api/webhooks - Get current webhook config */
router.get(
  '/',
  requireAuthOrApiKey as any,
  webhookReadLimiter,
  webhookController.getWebhookConfig as any
);

/** PUT /api/webhooks - Update webhook config */
router.put(
  '/',
  requireAuthOrApiKey as any,
  webhookWriteLimiter,
  webhookController.updateWebhookConfig as any
);

export default router;
