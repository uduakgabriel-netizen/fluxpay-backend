import { logger } from '../utils/logger';
import { Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import { AppError } from '../services/auth.service';
import * as apikeyService from '../services/apikey.service';
import { createApiKeySchema } from '../schemas/apikey.schema';
import { ApiKeyMode } from '@prisma/client';

/**
 * GET /api/api-keys
 * List all API keys (never returns actual key values)
 */
export async function listApiKeys(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const result = await apikeyService.listApiKeys(req.merchant.id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * POST /api/api-keys
 * Create a new API key — returns the plain key ONCE
 */
export async function createApiKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const parsed = createApiKeySchema.safeParse(req.body);
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

    const result = await apikeyService.createApiKey({
      merchantId: req.merchant.id,
      name: parsed.data.name,
      mode: parsed.data.mode as ApiKeyMode,
      permissions: parsed.data.permissions,
    });

    res.status(201).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * DELETE /api/api-keys/:id
 * Revoke an API key (permanent)
 */
export async function revokeApiKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'API key ID is required' });
      return;
    }

    const result = await apikeyService.revokeApiKey(id, req.merchant.id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * GET /api/api-keys/:id/stats
 * Get usage stats for an API key
 */
export async function getApiKeyStats(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'API key ID is required' });
      return;
    }

    const result = await apikeyService.getApiKeyStats(id, req.merchant.id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * Centralized error handler
 */
function handleError(error: unknown, res: Response): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  logger.error('API Key controller error:', error);
  res.status(500).json({ error: 'Internal server error' });
}
