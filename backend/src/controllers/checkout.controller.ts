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
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { memoryMerchants } from '../services/auth.service';
import { apiKeyToMerchantMap, memorySecrets } from '../services/secret.service';
import { memoryApiKeys } from '../services/apikey.service';
import { extractApiKey } from '../middleware/apikey.middleware';

const prisma = new PrismaClient();

// ─── Validation Schemas ─────────────────────────────────────

const createSessionSchema = z.object({
  amount: z.number().positive('Amount must be positive'),
  token: z.string().min(1, 'Token is required').default('USDC'),
  orderId: z.string().optional(),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
  webhookUrl: z.string().url().optional(),
  metadata: z.record(z.any()).optional(),
});

const checkoutNonceSchema = z.object({
  customerWallet: z.string().min(32, 'Valid Solana wallet address required'),
});

const checkoutVerifySchema = z.object({
  customerWallet: z.string().min(32, 'Valid Solana wallet address required'),
  message: z.string().min(1, 'Message is required'),
  signature: z.string().min(1, 'Signature is required'),
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

export async function createSession(req: Request, res: Response): Promise<void> {
  try {
    // 1. Read x-api-key header (supporting x-api-key, X-API-KEY, or Authorization Bearer)
    const rawApiKey = (req.headers['x-api-key'] || req.headers['X-API-KEY']) as string | undefined;
    let apiKey = typeof rawApiKey === 'string' && rawApiKey.trim() ? rawApiKey.trim() : null;

    if (!apiKey) {
      apiKey = extractApiKey(req);
    }

    if (!apiKey) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    // 2. Hash it
    const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');

    // 3. Find the merchant via prisma.merchant.findFirst({ where: { apiKeyHash: hash } })
    let merchant: any = null;
    try {
      merchant = await prisma.merchant.findFirst({
        where: { apiKeyHash },
      });
    } catch (err: any) {
      logger.warn(`[Checkout] DB findFirst by apiKeyHash error: ${err.message}`);
    }

    // Fallbacks for ApiKey table and in-memory demo resilience
    if (!merchant) {
      try {
        const apiKeyRow = await prisma.apiKey.findUnique({
          where: { keyHash: apiKeyHash },
          include: { merchant: true },
        });
        if (apiKeyRow && !apiKeyRow.revoked && apiKeyRow.merchant) {
          merchant = apiKeyRow.merchant;
        }
      } catch (err: any) {
        logger.warn(`[Checkout] DB apiKey lookup error: ${err.message}`);
      }
    }

    if (!merchant) {
      merchant = apiKeyToMerchantMap.get(apiKeyHash);
    }

    if (!merchant) {
      for (const m of memoryMerchants.values()) {
        if (m && m.apiKeyHash === apiKeyHash) {
          merchant = m;
          break;
        }
      }
    }

    if (!merchant) {
      for (const [id, s] of memorySecrets.entries()) {
        if (s && s.apiKeyHash === apiKeyHash) {
          const memM = memoryMerchants.get(id);
          merchant = memM || { id };
          break;
        }
      }
    }

    if (!merchant) {
      for (const k of memoryApiKeys.values()) {
        if (k && k.keyHash === apiKeyHash && !k.revoked) {
          const memM = memoryMerchants.get(k.merchantId);
          merchant = memM || { id: k.merchantId };
          break;
        }
      }
    }

    // If no merchant → return 401 { error: "Invalid API key" }
    if (!merchant) {
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }

    // Attach resolved merchant to request for downstream handlers or logging
    (req as any).merchant = merchant;

    // 4. Validate request body (without merchantId)
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

    // 5. All subsequent logic uses the resolved merchant from the key
    const result = await checkoutService.createCheckoutSession({
      merchantId: merchant.id,
      amount: parsed.data.amount,
      token: parsed.data.token,
      orderId: parsed.data.orderId,
      successUrl: parsed.data.successUrl,
      cancelUrl: parsed.data.cancelUrl,
      webhookUrl: parsed.data.webhookUrl,
      metadata: parsed.data.metadata,
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

// ─── POST /api/checkout/sessions/:id/nonce ──────────────────

export async function createCheckoutNonce(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    const parsed = checkoutNonceSchema.safeParse(req.body);
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

    const result = await checkoutService.createCheckoutNonce(id, parsed.data.customerWallet);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

// ─── POST /api/checkout/sessions/:id/verify ─────────────────

export async function verifyCheckoutSignature(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Session ID is required' });
      return;
    }

    const parsed = checkoutVerifySchema.safeParse(req.body);
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

    const result = await checkoutService.verifyCheckoutSignature(
      id,
      parsed.data.customerWallet,
      parsed.data.message,
      parsed.data.signature
    );
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

    const authHeader = req.headers.authorization;
    const customerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;

    const result = await checkoutService.executeCheckoutPayment(
      id, 
      parsed.data.buyerWallet,
      parsed.data.inputToken,
      parsed.data.inputAmount,
      customerToken
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
