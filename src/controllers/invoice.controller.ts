import { logger } from '../utils/logger';
import { Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import * as invoiceService from '../services/invoice.service';
import { AppError } from '../services/auth.service';

function handleError(error: unknown, res: Response): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  logger.error('Invoice controller error:', error);
  res.status(500).json({ error: 'Internal server error' });
}

/**
 * GET /api/invoices
 */
export async function list(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await invoiceService.listInvoices(req.merchant!.id, {
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      status: req.query.status as string | undefined,
    });
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * POST /api/invoices
 */
export async function create(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await invoiceService.createInvoice(req.merchant!.id, req.body);
    res.status(201).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * PATCH /api/invoices/:id/status
 */
export async function updateStatus(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await invoiceService.updateInvoiceStatus(
      req.merchant!.id,
      req.params.id,
      req.body.status
    );
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * DELETE /api/invoices/:id
 */
export async function remove(req: AuthRequest, res: Response): Promise<void> {
  try {
    await invoiceService.deleteInvoice(req.merchant!.id, req.params.id);
    res.status(200).json({ message: 'Invoice deleted' });
  } catch (error) {
    handleError(error, res);
  }
}
