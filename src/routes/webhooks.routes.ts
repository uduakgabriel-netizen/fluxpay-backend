import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { verifyWebhookSignature } from '../middleware/verifyWebhookSignature';
import {
  handleHeliusWebhook,
  handleNgnWebhook,
  handleUsdEurWebhook,
} from '../controllers/webhooks.controller';

const router = Router();

// POST /api/webhooks/helius — Receive payment detection from Helius
router.post(
  '/helius',
  verifyWebhookSignature('HELIUS_WEBHOOK_SECRET', 'Helius', [
    'x-helius-signature',
    'x-signature',
    'authorization',
  ]),
  asyncHandler(handleHeliusWebhook)
);

// POST /api/webhooks/ngn — Receive payout status updates from OneLiquidity NGN provider
router.post(
  '/ngn',
  verifyWebhookSignature('ONELIQUIDITY_WEBHOOK_SECRET', 'OneLiquidity', [
    'x-oneliquidity-signature',
    'x-ngn-signature',
    'x-webhook-signature',
    'x-signature',
    'authorization',
  ]),
  asyncHandler(handleNgnWebhook)
);

// POST /api/webhooks/usdeur — Receive payout status updates from USD/EUR provider (stub)
router.post(
  '/usdeur',
  verifyWebhookSignature('USDEUR_WEBHOOK_SECRET', 'USD-EUR', [
    'x-usdeur-signature',
    'x-usd-eur-signature',
    'x-webhook-signature',
    'x-signature',
  ]),
  asyncHandler(handleUsdEurWebhook)
);

export default router;
