/**
 * Checkout Controller
 *
 * Handles the hosted checkout API endpoints:
 * - POST   /api/checkout/sessions          — Create checkout session (API key auth)
 * - GET    /api/checkout/sessions/:id       — Get session details (public)
 * - GET    /api/checkout/sessions/:id/status — Poll status (public)
 * - POST   /api/checkout/sessions/:id/execute — Execute payment (public)
 * - POST   /api/checkout/sessions/:id/confirm — Confirm tx hash (public)
 */

import { Request, Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import { AppError } from '../services/auth.service';
import { logger } from '../utils/logger';
import * as checkoutService from '../services/checkout.service';
import { z } from 'zod';

// ─── Validation Schemas ─────────────────────────────────────

const createSessionSchema = z.object({
  amount: z.number().positive('Amount must be positive'),
  token: z.string().min(1, 'Token is required').default('USDC'),
  orderId: z.string().optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
  webhookUrl: z.string().url().optional(),
});

const executeSchema = z.object({
  buyerWallet: z.string().min(32, 'Valid Solana wallet address required'),
  inputToken: z.string().min(1, 'Input token is required'),
  inputAmount: z.number().positive('Input amount must be positive'),
});

const confirmSchema = z.object({
  txHash: z.string().min(44, 'Valid transaction signature required').optional(),
  txSignature: z.string().min(44, 'Valid transaction signature required').optional(),
}).refine(data => data.txHash || data.txSignature, {
  message: 'txHash or txSignature is required',
});

// ─── POST /api/checkout/sessions ────────────────────────────

export async function createSession(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'API key authentication required' });
      return;
    }

    const parsed = createSessionSchema.safeParse(req.body);
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

    const result = await checkoutService.createCheckoutSession({
      merchantId: req.merchant.id,
      amount: parsed.data.amount,
      token: parsed.data.token,
      orderId: parsed.data.orderId,
      successUrl: parsed.data.successUrl,
      cancelUrl: parsed.data.cancelUrl,
      webhookUrl: parsed.data.webhookUrl,
    });

    res.status(201).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

// ─── GET /api/checkout/sessions/:id ─────────────────────────

export async function getSession(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    const result = await checkoutService.getCheckoutSession(id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

// ─── GET /api/checkout/sessions/:id/status ──────────────────

export async function getSessionStatus(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    const result = await checkoutService.getCheckoutSessionStatus(id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

// ─── POST /api/checkout/sessions/:id/execute ────────────────

export async function executePayment(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    const parsed = executeSchema.safeParse(req.body);
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

    const result = await checkoutService.executeCheckoutPayment(
      id, 
      parsed.data.buyerWallet,
      parsed.data.inputToken,
      parsed.data.inputAmount
    );
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

// ─── POST /api/checkout/sessions/:id/confirm ────────────────

export async function confirmPayment(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    const parsed = confirmSchema.safeParse(req.body);
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

    const txSig = parsed.data.txHash || parsed.data.txSignature!;
    const result = await checkoutService.confirmCheckoutPayment(id, txSig);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

// ─── Error Handler ──────────────────────────────────────────

function handleError(error: unknown, res: Response): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  logger.error('Checkout controller error:', error);
  res.status(500).json({ error: 'Internal server error' });
}
