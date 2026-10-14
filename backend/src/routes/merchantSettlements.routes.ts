import { Router } from 'express';
import { MerchantSettlementsController } from '../controllers/merchantSettlements.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.get(
  '/',
  requireAuth as any,
  asyncHandler(MerchantSettlementsController.list)
);

router.post(
  '/trigger',
  requireAuth as any,
  asyncHandler(MerchantSettlementsController.trigger)
);

router.get(
  '/:id',
  requireAuth as any,
  asyncHandler(MerchantSettlementsController.getById)
);

export default router;
