import { Response } from 'express';
import { AuthContextRequest } from '../middleware/requireConsumerOrMerchantAuth';
import { OfframpExecutionService } from '../services/offrampExecution.service';
import { AuthError } from '../errors/AppError';

function getActor(req: AuthContextRequest) {
  if (req.actor) return req.actor;
  if (req.user?.id) return { type: 'consumer' as const, id: req.user.id };
  if (req.merchant?.id) return { type: 'merchant' as const, id: req.merchant.id };
  throw new AuthError('Authentication required');
}

export class OfframpController {
  /**
   * POST /api/offramp/execute
   */
  static async execute(req: AuthContextRequest, res: Response) {
    const actor = getActor(req);
    const result = await OfframpExecutionService.execute(actor, req.body);
    return res.status(200).json(result);
  }

  /**
   * POST /api/offramp/submit
   */
  static async submit(req: AuthContextRequest, res: Response) {
    const actor = getActor(req);
    const result = await OfframpExecutionService.submit(actor, req.body);
    return res.status(200).json(result);
  }

  /**
   * GET /api/offramp/transactions
   */
  static async list(req: AuthContextRequest, res: Response) {
    const actor = getActor(req);
    const result = await OfframpExecutionService.list(actor, req.query);
    return res.status(200).json(result);
  }

  /**
   * GET /api/offramp/transactions/:id
   */
  static async getById(req: AuthContextRequest, res: Response) {
    const actor = getActor(req);
    const { id } = req.params;
    const result = await OfframpExecutionService.getById(actor, id);
    return res.status(200).json(result);
  }

  /**
   * GET /api/offramp/transactions/:id/status
   */
  static async getStatus(req: AuthContextRequest, res: Response) {
    const actor = getActor(req);
    const { id } = req.params;
    const result = await OfframpExecutionService.getStatus(actor, id);
    return res.status(200).json(result);
  }
}
