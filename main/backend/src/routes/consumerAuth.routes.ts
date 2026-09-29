import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as consumerAuthController from '../controllers/consumerAuth.controller';
import { requireConsumerAuth } from '../middleware/requireConsumerAuth';

const router = Router();

// Rate limiter for nonce generation: 5 requests per minute per IP
const nonceLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 5,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Public Consumer Auth Endpoints ─────────────────────────
router.post('/nonce', nonceLimiter, consumerAuthController.getNonce);
router.post('/verify', consumerAuthController.verify);

// ─── Protected Consumer Auth Endpoints ──────────────────────
router.get('/me', requireConsumerAuth, consumerAuthController.me);

export default router;
