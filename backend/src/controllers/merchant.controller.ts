import { logger } from '../utils/logger';
import { Request, Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import { PrismaClient } from '@prisma/client';
import { getTokenBySymbol } from '../utils/token-registry';
import { getWalletBalance } from '../services/solana-wallet.service';

const prisma = new PrismaClient();

/**
 * GET /api/merchants/me
 * Get current authenticated merchant's info including token preferences
 */
export async function getMerchantInfo(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const merchant = await prisma.merchant.findUnique({
      where: { id: req.merchant.id },
      select: {
        id: true,
        walletAddress: true,
        email: true,
        businessName: true,
        emailVerified: true,
        createdAt: true,
        preferredTokenMint: true,
        preferredTokenSymbol: true,
        preferredTokenDecimals: true,
        hasSelectedToken: true,
        preferredTokenUpdatedAt: true,
      },
    });

    if (!merchant) {
      res.status(404).json({ error: 'Merchant not found' });
      return;
    }

    res.status(200).json({
      id: merchant.id,
      walletAddress: merchant.walletAddress,
      email: merchant.email,
      businessName: merchant.businessName,
      emailVerified: merchant.emailVerified,
      createdAt: merchant.createdAt.toISOString(),
      preferredTokenMint: merchant.preferredTokenMint || undefined,
      preferredTokenSymbol: merchant.preferredTokenSymbol || undefined,
      preferredTokenDecimals: merchant.preferredTokenDecimals || undefined,
      hasSelectedToken: merchant.hasSelectedToken,
      preferredTokenUpdatedAt: merchant.preferredTokenUpdatedAt?.toISOString(),
    });
  } catch (error) {
    logger.error('Error fetching merchant info:', error);
    res.status(500).json({ error: 'Failed to fetch merchant info' });
  }
}

/**
 * PUT /api/merchants/preferred-token
 * Update merchant's preferred settlement token
 * Body: { preferredTokenMint, preferredTokenSymbol, preferredTokenDecimals }
 */
export async function updatePreferredToken(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { preferredTokenMint, preferredTokenSymbol, preferredTokenDecimals } = req.body;

    // Validate token symbol is provided
    if (!preferredTokenSymbol) {
      res.status(400).json({ error: 'preferredTokenSymbol is required' });
      return;
    }

    // Validate token is supported
    const tokenInfo = getTokenBySymbol(preferredTokenSymbol);
    if (!tokenInfo) {
      res.status(400).json({ error: `Token ${preferredTokenSymbol} is not supported` });
      return;
    }

    // Update merchant's preferred token
    const updated = await prisma.merchant.update({
      where: { id: req.merchant.id },
      data: {
        preferredTokenMint: preferredTokenMint || tokenInfo.mintAddress,
        preferredTokenSymbol: preferredTokenSymbol,
        preferredTokenDecimals: preferredTokenDecimals || tokenInfo.decimals,
        hasSelectedToken: true,
        preferredTokenUpdatedAt: new Date(),
      },
      select: {
        id: true,
        walletAddress: true,
        email: true,
        businessName: true,
        preferredTokenMint: true,
        preferredTokenSymbol: true,
        preferredTokenDecimals: true,
        hasSelectedToken: true,
        preferredTokenUpdatedAt: true,
      },
    });

    res.status(200).json({
      message: 'Preferred token updated successfully',
      merchant: {
        id: updated.id,
        walletAddress: updated.walletAddress,
        email: updated.email,
        businessName: updated.businessName,
        preferredTokenMint: updated.preferredTokenMint,
        preferredTokenSymbol: updated.preferredTokenSymbol,
        preferredTokenDecimals: updated.preferredTokenDecimals,
        hasSelectedToken: updated.hasSelectedToken,
        preferredTokenUpdatedAt: updated.preferredTokenUpdatedAt?.toISOString(),
      },
    });
  } catch (error) {
    logger.error('Error updating preferred token:', error);
    res.status(500).json({ error: 'Failed to update preferred token' });
  }
}

/**
 * GET /api/merchants/balance
 * Check merchant wallet SOL balance
 */
export async function getMerchantBalance(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const merchant = await prisma.merchant.findUnique({
      where: { id: req.merchant.id },
      select: { walletAddress: true },
    });

    if (!merchant) {
      res.status(404).json({ error: 'Merchant not found' });
      return;
    }

    const balance = await getWalletBalance(merchant.walletAddress);

    res.status(200).json({
      walletAddress: merchant.walletAddress,
      sol: balance.sol,
      tokens: balance.tokens,
      canReceiveNewTokens: balance.sol >= 0.005,
      minSolRequired: 0.005,
    });
  } catch (error) {
    logger.error('Error fetching merchant balance:', error);
    res.status(500).json({ error: 'Failed to fetch merchant balance' });
  }
}
