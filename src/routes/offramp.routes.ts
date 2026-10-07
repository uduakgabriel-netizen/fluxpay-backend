import { Router } from 'express';
import { OfframpController } from '../controllers/offramp.controller';
import { QuoteController } from '../controllers/quote.controller';
import {
  requireConsumerOrMerchantAuth,
  optionalConsumerOrMerchantAuth,
} from '../middleware/requireConsumerOrMerchantAuth';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

// ─── Quote Endpoints ─────────────────────────────────────────
router.post('/quote', optionalConsumerOrMerchantAuth, asyncHandler(QuoteController.createQuote));
router.get('/quote/:quoteId', asyncHandler(QuoteController.getQuote));

// ─── Off-Ramp Execution Endpoints (Stage 5) ─────────────────
router.post(
  '/execute',
  requireConsumerOrMerchantAuth,
  asyncHandler(OfframpController.execute)
);

router.post(
  '/submit',
  requireConsumerOrMerchantAuth,
  asyncHandler(OfframpController.submit)
);

router.get(
  '/transactions',
  requireConsumerOrMerchantAuth,
  asyncHandler(OfframpController.list)
);

router.get(
  '/transactions/:id',
  requireConsumerOrMerchantAuth,
  asyncHandler(OfframpController.getById)
);

router.get(
  '/transactions/:id/status',
  requireConsumerOrMerchantAuth,
  asyncHandler(OfframpController.getStatus)
);

export default router;
