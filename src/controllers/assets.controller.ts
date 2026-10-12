import { Request, Response } from 'express';
import { TokenRegistryService } from '../services/tokenRegistry.service';
import { logger } from '../utils/logger';

/**
 * GET /api/assets/sellable
 * Public endpoint to list all sellable tokens supported by the platform.
 * Supports optional search, limit, and offset query parameters.
 */
export async function getSellableTokens(req: Request, res: Response): Promise<void> {
  try {
    const search = req.query.search as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

    const result = await TokenRegistryService.getSellableTokens({
      search,
      limit,
      offset,
    });

    res.status(200).json(result);
  } catch (error: any) {
    logger.error('[assets.controller] getSellableTokens error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/assets/sellable/:mint
 * Public endpoint to get a single sellable token by its Solana mint address.
 */
export async function getSellableTokenByMint(req: Request, res: Response): Promise<void> {
  try {
    const { mint } = req.params;

    if (!mint || typeof mint !== 'string' || !mint.trim()) {
      res.status(400).json({ error: 'Mint address is required' });
      return;
    }

    const token = await TokenRegistryService.getSellableTokenByMint(mint);

    if (!token) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }

    res.status(200).json(token);
  } catch (error: any) {
    logger.error('[assets.controller] getSellableTokenByMint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
