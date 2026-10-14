import { logger } from '../utils/logger';
import { Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import { AppError } from '../services/auth.service';
import * as paymentService from '../services/payment.service';
import { createPaymentSchema, listPaymentsSchema, exportPaymentsSchema } from '../schemas/payment.schema';
import { PaymentStatus } from '@prisma/client';

/**
 * POST /api/payments
 * Create a new payment session (non-custodial)
 */
export async function createPayment(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Validate request body
    const parsed = createPaymentSchema.safeParse(req.body);
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

    const result = await paymentService.createPayment({
      merchantId: req.merchant.id,
      amount: parsed.data.amount,
      token: parsed.data.token,
      customerEmail: parsed.data.customerEmail || undefined,
      customerWallet: parsed.data.customerWallet || undefined,
      metadata: parsed.data.metadata,
    });

    res.status(201).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * GET /api/payments
 * List payments with filters, pagination, and summary
 */
export async function listPayments(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Validate query params
    const parsed = listPaymentsSchema.safeParse(req.query);
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

    const result = await paymentService.listPayments({
      merchantId: req.merchant.id,
      page: parsed.data.page,
      limit: parsed.data.limit,
      status: parsed.data.status as PaymentStatus | undefined,
      token: parsed.data.token,
      fromDate: parsed.data.fromDate,
      toDate: parsed.data.toDate,
      search: parsed.data.search,
    });

    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * GET /api/payments/export
 * Export payments to CSV file download
 */
export async function exportPayments(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Validate query params
    const parsed = exportPaymentsSchema.safeParse(req.query);
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

    const csv = await paymentService.exportPayments(req.merchant.id, {
      fromDate: parsed.data.fromDate,
      toDate: parsed.data.toDate,
      status: parsed.data.status as PaymentStatus | undefined,
      token: parsed.data.token,
    });

    const filename = `fluxpay-payments-${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csv);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * GET /api/payments/:id
 * Get detailed payment information
 */
export async function getPayment(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Payment ID is required' });
      return;
    }

    const result = await paymentService.getPaymentById(id, req.merchant.id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * GET /api/payments/:id/status
 * Check payment status (lightweight endpoint for polling)
 */
export async function getPaymentStatus(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Payment ID is required' });
      return;
    }

    const result = await paymentService.getPaymentStatus(id, req.merchant.id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * POST /api/payments/:id/retry
 * Retry a failed payment swap
 */
export async function retryPayment(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Payment ID is required' });
      return;
    }

    const result = await paymentService.retryPayment(id, req.merchant.id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * GET /api/payments/stats
 * Get dashboard overview stats (revenue, transactions, token distribution, etc.)
 */
export async function getStats(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const result = await paymentService.getPaymentStats(req.merchant.id);
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
  logger.error('Payment controller error:', error);
  res.status(500).json({ error: 'Internal server error' });
}
