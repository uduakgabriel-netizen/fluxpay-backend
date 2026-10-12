import { logger } from '../utils/logger';
import { Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import { AppError } from '../services/auth.service';
import * as refundService from '../services/refund.service';
import { createRefundSchema, listRefundsSchema, rejectRefundSchema } from '../schemas/refund.schema';
import { RefundStatus } from '@prisma/client';

/**
 * POST /api/refunds
 * Request a refund for a completed payment
 */
export async function createRefund(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const parsed = createRefundSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      });
      return;
    }

    const result = await refundService.createRefund({
      merchantId: req.merchant.id,
      paymentId: parsed.data.paymentId,
      amount: parsed.data.amount,
      reason: parsed.data.reason,
      note: parsed.data.note,
    });

    res.status(201).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * GET /api/refunds
 * List refunds with filters and pagination
 */
export async function listRefunds(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const parsed = listRefundsSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      });
      return;
    }

    const result = await refundService.listRefunds({
      merchantId: req.merchant.id,
      page: parsed.data.page,
      limit: parsed.data.limit,
      status: parsed.data.status as RefundStatus | undefined,
      fromDate: parsed.data.fromDate,
      toDate: parsed.data.toDate,
    });

    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * GET /api/refunds/:id
 * Get detailed refund information
 */
export async function getRefund(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Refund ID is required' });
      return;
    }

    const result = await refundService.getRefundById(id, req.merchant.id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * PUT /api/refunds/:id/approve
 * Approve a pending refund
 */
export async function approveRefund(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Refund ID is required' });
      return;
    }

    const result = await refundService.approveRefund(
      id,
      req.merchant.id,
      req.merchant.email || ''
    );

    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * PUT /api/refunds/:id/reject
 * Reject a pending refund
 */
export async function rejectRefund(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Refund ID is required' });
      return;
    }

    const parsed = rejectRefundSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.errors.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      });
      return;
    }

    const result = await refundService.rejectRefund(
      id,
      req.merchant.id,
      parsed.data.reason
    );

    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * POST /api/refunds/:id/process
 * Process an approved refund on-chain
 */
export async function processRefund(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Refund ID is required' });
      return;
    }

    const result = await refundService.processRefund(id, req.merchant.id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * Centralized error handler for controller methods
 */
function handleError(error: unknown, res: Response): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  logger.error('Refund controller error:', error);
  res.status(500).json({ error: 'Internal server error' });
}
