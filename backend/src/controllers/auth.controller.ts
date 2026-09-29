import { logger } from '../utils/logger';
import { Request, Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import * as authService from '../services/auth.service';
import { AppError } from '../services/auth.service';

/**
 * POST /api/auth/nonce
 * Generate a nonce for wallet signing
 */
export async function getNonce(req: Request, res: Response): Promise<void> {
  try {
    const { walletAddress } = req.body;
    const result = await authService.createNonce(walletAddress);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * POST /api/auth/verify
 * Verify wallet signature and create session
 */
export async function verify(req: Request, res: Response): Promise<void> {
  try {
    const result = await authService.verifyAndLogin(req.body);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * POST /api/auth/signup
 * Create a new merchant account
 */
export async function signup(req: Request, res: Response): Promise<void> {
  try {
    const result = await authService.signup(req.body);
    res.status(201).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * GET /api/auth/me
 * Get current merchant info (protected)
 */
export async function me(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const result = await authService.getMe(req.merchant.id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * PATCH /api/auth/profile
 * Update merchant profile (protected)
 */
export async function updateProfile(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const result = await authService.updateProfile(req.merchant.id, req.body);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * POST /api/auth/logout
 * Invalidate session (protected)
 */
export async function logout(req: AuthRequest, res: Response): Promise<void> {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      res.status(400).json({ error: 'No token provided' });
      return;
    }
    await authService.logout(token);
    res.status(200).json({ message: 'Logged out successfully' });
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
  logger.error('Controller error:', error);
  res.status(500).json({ error: 'Internal server error' });
}
