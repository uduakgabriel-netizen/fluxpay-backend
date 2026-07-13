import { logger } from '../utils/logger';
/**
 * Helius Webhook Controller
 *
 * Handles incoming Helius webhook requests for real-time
 * Solana transaction detection.
 */

import { Request, Response } from 'express';
import { processHeliusWebhook, verifyHeliusAuth } from '../services/helius.service';

/**
 * POST /api/webhooks/helius
 *
 * Receives enhanced transaction data from Helius.
 * Validates auth, processes transactions, and returns results.
 */
export async function handleHeliusWebhook(req: Request, res: Response): Promise<void> {
  try {
    // Validate Helius authentication
    const authHeader = req.headers.authorization || (req.headers['x-helius-api-key'] as string);

    if (!verifyHeliusAuth(authHeader)) {
      logger.warn('[Helius] Unauthorized webhook request');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const payload = req.body;

    // Helius sends an array of transactions
    if (!payload || (Array.isArray(payload) && payload.length === 0)) {
      res.status(200).json({ message: 'No transactions to process' });
      return;
    }

    // Ensure payload is an array
    const transactions = Array.isArray(payload) ? payload : [payload];

    logger.info(`[Helius] Received webhook with ${transactions.length} transaction(s)`);

    // Process asynchronously — return 200 immediately so Helius doesn't retry
    // We process in the background
    const results = await processHeliusWebhook(transactions);

    res.status(200).json({
      success: true,
      processed: results.processed,
      matched: results.matched,
      errors: results.errors.length,
    });
  } catch (error: any) {
    logger.error('[Helius] Webhook handler error:', error);
    // Still return 200 to prevent Helius retries on our errors
    res.status(200).json({
      success: false,
      error: 'Internal processing error',
    });
  }
}

/**
 * GET /api/webhooks/helius/health
 *
 * Health check for the Helius webhook endpoint.
 */
export async function heliusWebhookHealth(req: Request, res: Response): Promise<void> {
  res.status(200).json({
    status: 'ok',
    endpoint: '/api/webhooks/helius',
    network: process.env.SOLANA_NETWORK || 'devnet',
    heliusConfigured: !!process.env.HELIUS_API_KEY,
    timestamp: new Date().toISOString(),
  });
}
