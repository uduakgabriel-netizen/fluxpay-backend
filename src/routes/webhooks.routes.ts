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
  ]),
  asyncHandler(handleHeliusWebhook)
);

// POST /api/webhooks/ngn — Receive payout status updates from NGN provider
router.post(
  '/ngn',
  verifyWebhookSignature('NGN_WEBHOOK_SECRET', 'NGN', [
    'x-ngn-signature',
    'x-webhook-signature',
    'x-signature',
  ]),
  asyncHandler(handleNgnWebhook)
);

// POST /api/webhooks/usdeur — Receive payout status updates from USD/EUR provider
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
