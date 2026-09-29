import { PrismaClient } from '@prisma/client';
import { generateApiKey, generateWebhookSecretKey } from '../utils/secrets';
import { AppError } from './auth.service';

const prisma = new PrismaClient();

// ─── Combined Credentials Generation ────────────────────────

/**
 * Generate BOTH API key + webhook secret together in one atomic operation.
 * This is the primary function merchants use from the dashboard.
 * Returns plaintext keys ONCE — they are never retrievable again.
 */
export async function generateCredentials(merchantId: string, mode: 'live' | 'test' = 'live') {
  const apiKey = generateApiKey(mode);
  const webhookSecret = generateWebhookSecretKey();

  const merchant = await prisma.merchant.update({
    where: { id: merchantId },
    data: {
      // API Key — store hash only
      apiKeyHash: apiKey.keyHash,
      apiKeyPrefix: apiKey.prefix,
      apiKeyLastChars: apiKey.lastChars,
      apiKeyRotatedAt: new Date(),
      // Webhook Secret — store plaintext (needed for HMAC signing outgoing webhooks)
      webhookSecret: webhookSecret.fullSecret,
      webhookSecretPrefix: webhookSecret.prefix,
      webhookSecretLastChars: webhookSecret.lastChars,
      webhookSecretRotatedAt: new Date(),
    },
  });

  return {
    apiKey: {
      fullKey: apiKey.fullKey,       // ⚠️ Show ONCE, never again
      prefix: apiKey.prefix,
      lastChars: apiKey.lastChars,
    },
    webhookSecret: {
      fullSecret: webhookSecret.fullSecret, // ⚠️ Show ONCE, never again
      prefix: webhookSecret.prefix,
      lastChars: webhookSecret.lastChars,
    },
    rotatedAt: merchant.apiKeyRotatedAt?.toISOString(),
    warning: 'Save these credentials now. You will not be able to see them again.',
  };
}

// ─── API Key Management ─────────────────────────────────────

export async function rollApiKey(merchantId: string, mode: 'live' | 'test' = 'live') {
  // Use combined generation so webhook secret is always in sync
  return generateCredentials(merchantId, mode);
}

export async function getApiKeyInfo(merchantId: string) {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: {
      apiKeyPrefix: true,
      apiKeyLastChars: true,
      apiKeyRotatedAt: true,
    },
  });

  if (!merchant || !merchant.apiKeyPrefix) {
    return null; // No key exists
  }

  return {
    prefix: merchant.apiKeyPrefix,
    lastChars: merchant.apiKeyLastChars,
    rotatedAt: merchant.apiKeyRotatedAt?.toISOString(),
  };
}

export async function revokeApiKey(merchantId: string) {
  await prisma.merchant.update({
    where: { id: merchantId },
    data: {
      apiKeyHash: null,
      apiKeyPrefix: null,
      apiKeyLastChars: null,
    },
  });

  return { success: true, message: 'API key revoked successfully' };
}

// ─── Webhook Secret Management ──────────────────────────────

export async function rollWebhookSecret(merchantId: string) {
  const generated = generateWebhookSecretKey();

  const merchant = await prisma.merchant.update({
    where: { id: merchantId },
    data: {
      webhookSecret: generated.fullSecret,
      webhookSecretPrefix: generated.prefix,
      webhookSecretLastChars: generated.lastChars,
      webhookSecretRotatedAt: new Date(),
    },
  });

  return {
    fullSecret: generated.fullSecret, // WARNING: Only return once!
    prefix: generated.prefix,
    lastChars: generated.lastChars,
    rotatedAt: merchant.webhookSecretRotatedAt?.toISOString(),
  };
}

export async function getWebhookSecretInfo(merchantId: string) {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: {
      webhookSecretPrefix: true,
      webhookSecretLastChars: true,
      webhookSecretRotatedAt: true,
      webhookUrl: true,
    },
  });

  if (!merchant || !merchant.webhookSecretPrefix) {
    return {
      webhookUrl: merchant?.webhookUrl || null,
      secretInfo: null,
    };
  }

  return {
    webhookUrl: merchant.webhookUrl,
    secretInfo: {
      prefix: merchant.webhookSecretPrefix,
      lastChars: merchant.webhookSecretLastChars,
      rotatedAt: merchant.webhookSecretRotatedAt?.toISOString(),
    },
  };
}

export async function updateWebhookUrl(merchantId: string, webhookUrl: string | null) {
  // Add URL validation if it's not null
  if (webhookUrl) {
    try {
      new URL(webhookUrl);
    } catch {
      throw new AppError('Invalid webhook URL', 400);
    }
  }

  await prisma.merchant.update({
    where: { id: merchantId },
    data: { webhookUrl },
  });

  return { success: true, webhookUrl };
}
