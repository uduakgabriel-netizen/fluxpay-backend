import { logger } from '../utils/logger';
import { Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import { AppError } from '../services/auth.service';
import * as webhookService from '../services/webhook.service';
import {
  updateWebhookSchema,
  listWebhookLogsSchema,
  WEBHOOK_EVENTS,
} from '../schemas/webhook.schema';
import { WebhookLogStatus } from '@prisma/client';

/**
 * GET /api/webhooks
 * Get current webhook configuration
 */
export async function getWebhookConfig(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const result = await webhookService.getWebhookConfig(req.merchant.id);

    // Include available events for reference
    res.status(200).json({
      ...result,
      availableEvents: WEBHOOK_EVENTS,
    });
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * PUT /api/webhooks
 * Create or update webhook configuration
 */
export async function updateWebhookConfig(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const parsed = updateWebhookSchema.safeParse(req.body);
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

    const result = await webhookService.updateWebhookConfig({
      merchantId: req.merchant.id,
      url: parsed.data.url,
      events: parsed.data.events,
      active: parsed.data.active,
      maxRetries: parsed.data.maxRetries,
    });

    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * POST /api/webhooks/test
 * Send a test webhook to verify the connection
 */
export async function testWebhook(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const result = await webhookService.testWebhook(req.merchant.id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * GET /api/webhooks/logs
 * List webhook delivery logs with filters
 */
export async function listWebhookLogs(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!req.merchant) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const parsed = listWebhookLogsSchema.safeParse(req.query);
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

    const result = await webhookService.listWebhookLogs({
      merchantId: req.merchant.id,
      page: parsed.data.page,
      limit: parsed.data.limit,
      event: parsed.data.event,
      status: parsed.data.status as WebhookLogStatus | undefined,
      fromDate: parsed.data.fromDate,
      toDate: parsed.data.toDate,
    });

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
  logger.error('Webhook controller error:', error);
  res.status(500).json({ error: 'Internal server error' });
}
