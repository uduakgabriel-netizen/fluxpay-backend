import { Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import * as secretService from '../services/secret.service';
import { AppError } from '../services/auth.service';
import { logger } from '../utils/logger';

// ─── API Key Endpoints ──────────────────────────────────────

export async function getApiKeyInfo(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const info = await secretService.getApiKeyInfo(req.merchant.id);
    res.status(200).json({ apiKey: info });
  } catch (error) {
    handleError(error, res);
  }
}

export async function rollApiKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const mode = req.body.mode === 'test' ? 'test' : 'live';
    const result = await secretService.generateCredentials(req.merchant.id, mode);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

export async function revokeApiKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const result = await secretService.revokeApiKey(req.merchant.id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

// ─── Webhook Endpoints ──────────────────────────────────────

export async function getWebhookInfo(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const info = await secretService.getWebhookSecretInfo(req.merchant.id);
    res.status(200).json(info);
  } catch (error) {
    handleError(error, res);
  }
}

export async function rollWebhookSecret(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const result = await secretService.rollWebhookSecret(req.merchant.id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

export async function updateWebhookUrl(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    const { webhookUrl } = req.body;
    const result = await secretService.updateWebhookUrl(req.merchant.id, webhookUrl);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

function handleError(error: unknown, res: Response): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  logger.error('Secret controller error:', error);
  res.status(500).json({ error: 'Internal server error' });
}
