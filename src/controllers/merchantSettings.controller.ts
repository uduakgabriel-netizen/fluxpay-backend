import { Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import { MerchantSettingsService } from '../services/merchantSettings.service';
import { AuthError } from '../errors/AppError';

export class MerchantSettingsController {
  /**
   * GET /api/merchant/settings/settlement
   */
  static async getSettlementSettings(req: AuthRequest, res: Response) {
    if (!req.merchant?.id) {
      throw new AuthError();
    }
    const result = await MerchantSettingsService.getSettlementSettings(req.merchant.id);
    return res.status(200).json(result);
  }

  /**
   * PATCH /api/merchant/settings/settlement
   */
  static async updateSettlementSettings(req: AuthRequest, res: Response) {
    if (!req.merchant?.id) {
      throw new AuthError();
    }
    const result = await MerchantSettingsService.updateSettlementSettings(
      req.merchant.id,
      req.body
    );
    return res.status(200).json(result);
  }
}
