/**
 * Helius Webhook Routes
 *
 * Routes for receiving Solana transaction data from Helius.
 * These are NOT protected by API key/JWT since Helius calls them.
 * Authentication is via Helius API key in the header instead.
 */

import { Router } from 'express';
import { handleHeliusWebhook, heliusWebhookHealth } from '../controllers/helius.controller';

const router = Router();

// POST /api/webhooks/helius — Receive Helius transaction webhooks
router.post('/', handleHeliusWebhook);

// GET /api/webhooks/helius/health — Health check
router.get('/health', heliusWebhookHealth);

export default router;
