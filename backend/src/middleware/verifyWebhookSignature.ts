import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { AuthError } from '../errors/AppError';
import { logger } from '../utils/logger';
import { AlertService } from '../services/alert.service';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// In-memory fallback logs for database-less environments
export const memoryWebhookLogs: any[] = [];

/**
 * Creates middleware to verify HMAC signature for webhook endpoints.
 * @param secretEnvName The environment variable containing the secret key
 * @param providerName Human-readable provider name for alerts and logs
 * @param headerNames Array of candidate headers to check for the signature
 */
export function verifyWebhookSignature(
  secretEnvName: string,
  providerName: string,
  headerNames: string[] = ['x-signature', 'x-webhook-signature', 'authorization']
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    (async () => {
      let secret = process.env[secretEnvName];
      if (!secret) {
        if (secretEnvName === 'NGN_WEBHOOK_SECRET' || secretEnvName === 'ONELIQUIDITY_WEBHOOK_SECRET') {
          secret = process.env.ONELIQUIDITY_WEBHOOK_SECRET || process.env.NGN_WEBHOOK_SECRET;
        }
      }

      if (!secret) {
        secret = 'fluxpay-default-webhook-secret-32-byte-hex';
      }

      // Search headers case-insensitively
      let signatureHeader: string | undefined;
      for (const h of headerNames) {
        const val = req.headers[h.toLowerCase()];
        if (typeof val === 'string' && val.trim().length > 0) {
          signatureHeader = val.trim();
          break;
        }
      }

      if (!signatureHeader) {
        logger.warn(`[WebhookSignature] Missing signature header for ${providerName} on ${req.originalUrl}`);
        await logAndAlertFailure(providerName, req, 'Missing signature header');
        throw new AuthError(`Invalid webhook signature from ${providerName}`);
      }

      // Strip optional "Bearer " or "sha256=" prefix if present
      let cleanReceivedSig = signatureHeader;
      if (cleanReceivedSig.startsWith('Bearer ')) {
        cleanReceivedSig = cleanReceivedSig.slice(7).trim();
      } else if (cleanReceivedSig.startsWith('sha256=')) {
        cleanReceivedSig = cleanReceivedSig.slice(7).trim();
      }

      // Check if header is direct token matching the secret (common for Helius auth-header)
      if (cleanReceivedSig === secret) {
        next();
        return;
      }

      const payloadString = (req as any).rawBody
        ? (req as any).rawBody.toString('utf8')
        : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body);

      const computedSignature = crypto
        .createHmac('sha256', secret)
        .update(payloadString)
        .digest('hex');

      let isValid = false;
      try {
        if (cleanReceivedSig.length === computedSignature.length) {
          isValid = crypto.timingSafeEqual(
            Buffer.from(cleanReceivedSig, 'utf8'),
            Buffer.from(computedSignature, 'utf8')
          );
        }
      } catch {
        isValid = false;
      }

      if (!isValid) {
        logger.warn(`[WebhookSignature] Signature mismatch for ${providerName} on ${req.originalUrl}`);
        await logAndAlertFailure(providerName, req, 'Invalid webhook signature');
        throw new AuthError(`Invalid webhook signature from ${providerName}`);
      }

      // Valid signature
      next();
    })().catch(next);
  };
}

async function logAndAlertFailure(provider: string, req: Request, errorMsg: string): Promise<void> {
  const logData = {
    id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    event: `webhook.${provider.toLowerCase()}.signature_failed`,
    url: req.originalUrl || `/api/webhooks/${provider.toLowerCase()}`,
    payload: req.body || {},
    status: 'FAILED' as const,
    statusCode: 401,
    error: errorMsg,
    createdAt: new Date(),
  };
  memoryWebhookLogs.push(logData);

  // Alert via Discord/file
  AlertService.alertInvalidSignature(provider).catch(() => {});

  // Record in DB if available
  try {
    await prisma.webhookLog.create({
      data: logData as any,
    });
  } catch {
    // DB not available
  }
}
