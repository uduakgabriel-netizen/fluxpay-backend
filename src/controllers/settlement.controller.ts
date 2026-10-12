import { logger } from '../utils/logger';
import { Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import { AppError } from '../services/auth.service';
import * as settlementService from '../services/settlement.service';
import { listSettlementsSchema, processSettlementSchema } from '../schemas/settlement.schema';
import { SettlementStatus } from '@prisma/client';

/**
 * GET /api/settlements
 * List settlements with filters and pagination
 */
export async function listSettlements(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const parsed = listSettlementsSchema.safeParse(req.query);
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

    const result = await settlementService.listSettlements({
      merchantId: req.merchant.id,
      page: parsed.data.page,
      limit: parsed.data.limit,
      status: parsed.data.status as SettlementStatus | undefined,
      fromDate: parsed.data.fromDate,
      toDate: parsed.data.toDate,
    });

    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * GET /api/settlements/:id
 * Get detailed settlement information
 */
export async function getSettlement(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Settlement ID is required' });
      return;
    }

    const result = await settlementService.getSettlementById(id, req.merchant.id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * POST /api/settlements/process
 * Manually trigger settlement processing (admin)
 */
export async function processSettlement(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const parsed = processSettlementSchema.safeParse(req.body);
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

    const result = await settlementService.processManualSettlement(
      req.merchant.id,
      parsed.data.token
    );

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
  logger.error('Settlement controller error:', error);
  res.status(500).json({ error: 'Internal server error' });
}
