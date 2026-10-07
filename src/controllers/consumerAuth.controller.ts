import { Request, Response } from 'express';
import { ConsumerAuthRequest } from '../middleware/requireConsumerAuth';
import * as consumerAuthService from '../services/consumerAuth.service';
import { ConsumerAuthError } from '../services/consumerAuth.service';
import { logger } from '../utils/logger';

/**
 * POST /api/auth/consumer/nonce
 * Generate a 5-minute one-time nonce for consumer wallet signing
 */
export async function getNonce(req: Request, res: Response): Promise<void> {
  try {
    const { walletAddress } = req.body;

    if (!walletAddress || typeof walletAddress !== 'string' || !walletAddress.trim()) {
      res.status(400).json({ error: 'walletAddress is required' });
      return;
    }

    const result = await consumerAuthService.generateConsumerNonce(walletAddress);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * POST /api/auth/consumer/verify
 * Verify wallet signature, upsert consumer record, return JWT
 */
export async function verify(req: Request, res: Response): Promise<void> {
  try {
    const { walletAddress, signature } = req.body;

    if (!walletAddress || typeof walletAddress !== 'string' || !walletAddress.trim()) {
      res.status(400).json({ error: 'walletAddress is required' });
      return;
    }

    if (!signature || typeof signature !== 'string' || !signature.trim()) {
      res.status(400).json({ error: 'signature is required' });
      return;
    }

    const result = await consumerAuthService.verifyConsumerSignature(
      walletAddress,
      signature
    );
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * GET /api/auth/consumer/me
 * Return profile of authenticated consumer
 */
export async function me(req: ConsumerAuthRequest, res: Response): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const profile = await consumerAuthService.getConsumerProfile(req.user.id);
    res.status(200).json(profile);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * Centralized error handler for consumer auth controller
 */
function handleError(error: unknown, res: Response): void {
  if (error instanceof ConsumerAuthError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  logger.error('[consumerAuth.controller] Unexpected error:', error);
  res.status(500).json({ error: 'Internal server error' });
}
