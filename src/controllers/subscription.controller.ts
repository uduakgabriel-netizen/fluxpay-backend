import { logger } from '../utils/logger';
import { Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import * as subscriptionService from '../services/subscription.service';
import { AppError } from '../services/auth.service';

function handleError(error: unknown, res: Response): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  logger.error('Subscription controller error:', error);
  res.status(500).json({ error: 'Internal server error' });
}

/**
 * GET /api/subscriptions
 */
export async function list(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await subscriptionService.listSubscriptions(req.merchant!.id, {
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      status: req.query.status as string | undefined,
      search: req.query.search as string | undefined,
    });
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * POST /api/subscriptions
 */
export async function create(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await subscriptionService.createSubscription(req.merchant!.id, req.body);
    res.status(201).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * PATCH /api/subscriptions/:id/:action
 */
export async function updateStatus(req: AuthRequest, res: Response): Promise<void> {
  try {
    const action = req.params.action as 'pause' | 'resume' | 'cancel';
    if (!['pause', 'resume', 'cancel'].includes(action)) {
      res.status(400).json({ error: 'Invalid action. Use pause, resume, or cancel.' });
      return;
    }
    const result = await subscriptionService.updateSubscriptionStatus(
      req.merchant!.id,
      req.params.id,
      action
    );
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}
