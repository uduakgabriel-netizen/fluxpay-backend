import { Router } from 'express';
import { MerchantSettingsController } from '../controllers/merchantSettings.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

router.get(
  '/settlement',
  requireAuth as any,
  asyncHandler(MerchantSettingsController.getSettlementSettings)
);

router.patch(
  '/settlement',
  requireAuth as any,
  asyncHandler(MerchantSettingsController.updateSettlementSettings)
);

export default router;
