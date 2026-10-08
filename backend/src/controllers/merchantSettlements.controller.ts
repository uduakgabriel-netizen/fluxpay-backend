import { Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import { SettlementService } from '../services/settlement.service';
import { AuthError } from '../errors/AppError';

export class MerchantSettlementsController {
  /**
   * GET /api/merchant/settlements
   */
  static async list(req: AuthRequest, res: Response) {
    if (!req.merchant?.id) {
      throw new AuthError();
    }
    const result = await SettlementService.listMerchantSettlements(
      req.merchant.id,
      req.query
    );
    return res.status(200).json(result);
  }

  /**
   * GET /api/merchant/settlements/:id
   */
  static async getById(req: AuthRequest, res: Response) {
    if (!req.merchant?.id) {
      throw new AuthError();
    }
    const { id } = req.params;
    const result = await SettlementService.getMerchantSettlementById(
      req.merchant.id,
      id
    );
    return res.status(200).json(result);
  }

  /**
   * POST /api/merchant/settlements/trigger
   */
  static async trigger(req: AuthRequest, res: Response) {
    if (!req.merchant?.id) {
      throw new AuthError();
    }
    const result = await SettlementService.triggerSettlement(req.merchant.id);
    return res.status(200).json(result);
  }
}
