import { PrismaClient } from '@prisma/client';
import { generateApiKey, generateWebhookSecretKey } from '../utils/secrets';
import { AppError, memoryMerchants } from './auth.service';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

// In-memory stores for secret management when PostgreSQL is unreachable or in dev mode
export interface MemorySecretData {
  apiKeyHash?: string;
  apiKeyPrefix?: string;
  apiKeyLastChars?: string;
  apiKeyRotatedAt?: Date;
  webhookSecret?: string;
  webhookSecretPrefix?: string;
  webhookSecretLastChars?: string;
  webhookSecretRotatedAt?: Date;
  webhookUrl?: string | null;
}

export const memorySecrets = new Map<string, MemorySecretData>();

// Map from sha256(apiKey) -> merchant details for O(1) auth lookup
export const apiKeyToMerchantMap = new Map<string, {
  id: string;
  walletAddress: string;
  email: string | null;
  businessName: string;
}>();

// Pre-seed live demo merchant API key
apiKeyToMerchantMap.set('ecff9540b8578dd4f1190c3235708d15dcd55e6fd8e0203f7cbd4803ee0817b5', {
  id: 'merchant_live',
  walletAddress: '7J5tPd33wXDFVcFvgPJdhiTrG3qxvJbCp1JiQZET3NFh',
  email: 'merchant@fluxpay.io',
  businessName: 'SHOEPLACE.NG',
});

// Pre-seed test demo merchant API key
apiKeyToMerchantMap.set('ae418e85eb4188cbfc31a81486748445b2542950dfee2779509f5bfd7ce02ac5', {
  id: 'merchant_live',
  walletAddress: '7J5tPd33wXDFVcFvgPJdhiTrG3qxvJbCp1JiQZET3NFh',
  email: 'merchant@fluxpay.io',
  businessName: 'SHOEPLACE.NG',
});

memorySecrets.set('merchant_live', {
  apiKeyHash: 'ae418e85eb4188cbfc31a81486748445b2542950dfee2779509f5bfd7ce02ac5',
  webhookSecret: process.env.FLUXPAY_WEBHOOK_SECRET || 'whsec_0f9c0a8271e4792feeade69df3f51c221f4eb9fa05658050',
  webhookUrl: 'http://localhost:3002/api/webhooks/fluxpay',
});

// ─── Combined Credentials Generation ────────────────────────

/**
 * Generate BOTH API key + webhook secret together in one atomic operation.
 * This is the primary function merchants use from the dashboard.
 * Returns plaintext keys ONCE — they are never retrievable again.
 */
export async function generateCredentials(merchantId: string, mode: 'live' | 'test' = 'live') {
  const apiKey = generateApiKey(mode);
  const webhookSecret = generateWebhookSecretKey();
  let rotatedAt = new Date();

  // Try DB persistence
  try {
    const merchant = await prisma.merchant.update({
      where: { id: merchantId },
      data: {
        // API Key — store hash only
        apiKeyHash: apiKey.keyHash,
        apiKeyPrefix: apiKey.prefix,
        apiKeyLastChars: apiKey.lastChars,
        apiKeyRotatedAt: rotatedAt,
        // Webhook Secret — store plaintext (needed for HMAC signing outgoing webhooks)
        webhookSecret: webhookSecret.fullSecret,
        webhookSecretPrefix: webhookSecret.prefix,
        webhookSecretLastChars: webhookSecret.lastChars,
        webhookSecretRotatedAt: rotatedAt,
      },
    });
    if (merchant?.apiKeyRotatedAt) {
      rotatedAt = merchant.apiKeyRotatedAt;
    }
  } catch (err: any) {
    logger.warn(`[SecretService] DB merchant update failed, using memory store: ${err.message}`);
  }

  // Update in-memory fallback store
  const existingSecret = memorySecrets.get(merchantId) || {};
  memorySecrets.set(merchantId, {
    ...existingSecret,
    apiKeyHash: apiKey.keyHash,
    apiKeyPrefix: apiKey.prefix,
    apiKeyLastChars: apiKey.lastChars,
    apiKeyRotatedAt: rotatedAt,
    webhookSecret: webhookSecret.fullSecret,
    webhookSecretPrefix: webhookSecret.prefix,
    webhookSecretLastChars: webhookSecret.lastChars,
    webhookSecretRotatedAt: rotatedAt,
  });

  // Register in quick apiKey lookup map
  const memMerchant = memoryMerchants.get(merchantId);
  const walletAddress = memMerchant?.walletAddress || '7J5tPd33wXDFVcFvgPJdhiTrG3qxvJbCp1JiQZET3NFh';
  const email = memMerchant?.email || 'merchant@fluxpay.io';
  const businessName = memMerchant?.businessName || 'FluxPay Merchant';

  apiKeyToMerchantMap.set(apiKey.keyHash, {
    id: merchantId,
    walletAddress,
    email,
    businessName,
  });

  if (memMerchant) {
    memMerchant.apiKeyHash = apiKey.keyHash;
    memMerchant.apiKeyPrefix = apiKey.prefix;
    memMerchant.apiKeyLastChars = apiKey.lastChars;
    memMerchant.apiKeyRotatedAt = rotatedAt;
    memMerchant.webhookSecret = webhookSecret.fullSecret;
    memMerchant.webhookSecretPrefix = webhookSecret.prefix;
    memMerchant.webhookSecretLastChars = webhookSecret.lastChars;
    memMerchant.webhookSecretRotatedAt = rotatedAt;
  }

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
    rotatedAt: rotatedAt.toISOString(),
    warning: 'Save these credentials now. You will not be able to see them again.',
  };
}

// ─── API Key Management ─────────────────────────────────────

export async function rollApiKey(merchantId: string, mode: 'live' | 'test' = 'live') {
  // Use combined generation so webhook secret is always in sync
  return generateCredentials(merchantId, mode);
}

export async function getApiKeyInfo(merchantId: string) {
  let merchant: any = null;
  try {
    merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: {
        apiKeyPrefix: true,
        apiKeyLastChars: true,
        apiKeyRotatedAt: true,
      },
    });
  } catch (err: any) {
    logger.warn(`[SecretService] DB getApiKeyInfo failed: ${err.message}`);
  }

  if (!merchant || !merchant.apiKeyPrefix) {
    const memory = memorySecrets.get(merchantId) || memoryMerchants.get(merchantId);
    if (memory && memory.apiKeyPrefix) {
      return {
        prefix: memory.apiKeyPrefix,
        lastChars: memory.apiKeyLastChars,
        rotatedAt: memory.apiKeyRotatedAt instanceof Date ? memory.apiKeyRotatedAt.toISOString() : (memory.apiKeyRotatedAt || new Date().toISOString()),
      };
    }
    return null; // No key exists
  }

  return {
    prefix: merchant.apiKeyPrefix,
    lastChars: merchant.apiKeyLastChars,
    rotatedAt: merchant.apiKeyRotatedAt?.toISOString(),
  };
}

export async function revokeApiKey(merchantId: string) {
  try {
    await prisma.merchant.update({
      where: { id: merchantId },
      data: {
        apiKeyHash: null,
        apiKeyPrefix: null,
        apiKeyLastChars: null,
      },
    });
  } catch (err: any) {
    logger.warn(`[SecretService] DB revokeApiKey failed: ${err.message}`);
  }

  const memory = memorySecrets.get(merchantId);
  if (memory) {
    if (memory.apiKeyHash) {
      apiKeyToMerchantMap.delete(memory.apiKeyHash);
    }
    memory.apiKeyHash = undefined;
    memory.apiKeyPrefix = undefined;
    memory.apiKeyLastChars = undefined;
    memory.apiKeyRotatedAt = undefined;
  }

  const memMerchant = memoryMerchants.get(merchantId);
  if (memMerchant) {
    if (memMerchant.apiKeyHash) {
      apiKeyToMerchantMap.delete(memMerchant.apiKeyHash);
    }
    memMerchant.apiKeyHash = null;
    memMerchant.apiKeyPrefix = null;
    memMerchant.apiKeyLastChars = null;
  }

  return { success: true, message: 'API key revoked successfully' };
}

// ─── Webhook Secret Management ──────────────────────────────

export async function rollWebhookSecret(merchantId: string) {
  const generated = generateWebhookSecretKey();
  let rotatedAt = new Date();

  try {
    const merchant = await prisma.merchant.update({
      where: { id: merchantId },
      data: {
        webhookSecret: generated.fullSecret,
        webhookSecretPrefix: generated.prefix,
        webhookSecretLastChars: generated.lastChars,
        webhookSecretRotatedAt: rotatedAt,
      },
    });
    if (merchant?.webhookSecretRotatedAt) {
      rotatedAt = merchant.webhookSecretRotatedAt;
    }
  } catch (err: any) {
    logger.warn(`[SecretService] DB rollWebhookSecret failed: ${err.message}`);
  }

  const memory = memorySecrets.get(merchantId) || {};
  memorySecrets.set(merchantId, {
    ...memory,
    webhookSecret: generated.fullSecret,
    webhookSecretPrefix: generated.prefix,
    webhookSecretLastChars: generated.lastChars,
    webhookSecretRotatedAt: rotatedAt,
  });

  const memMerchant = memoryMerchants.get(merchantId);
  if (memMerchant) {
    memMerchant.webhookSecret = generated.fullSecret;
    memMerchant.webhookSecretPrefix = generated.prefix;
    memMerchant.webhookSecretLastChars = generated.lastChars;
    memMerchant.webhookSecretRotatedAt = rotatedAt;
  }

  return {
    fullSecret: generated.fullSecret, // WARNING: Only return once!
    prefix: generated.prefix,
    lastChars: generated.lastChars,
    rotatedAt: rotatedAt.toISOString(),
  };
}

export async function getWebhookSecretInfo(merchantId: string) {
  let merchant: any = null;
  try {
    merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: {
        webhookSecretPrefix: true,
        webhookSecretLastChars: true,
        webhookSecretRotatedAt: true,
        webhookUrl: true,
      },
    });
  } catch (err: any) {
    logger.warn(`[SecretService] DB getWebhookSecretInfo failed: ${err.message}`);
  }

  const memory = memorySecrets.get(merchantId) || memoryMerchants.get(merchantId);
  const webhookUrl = merchant?.webhookUrl || memory?.webhookUrl || null;
  const prefix = merchant?.webhookSecretPrefix || memory?.webhookSecretPrefix || null;
  const lastChars = merchant?.webhookSecretLastChars || memory?.webhookSecretLastChars || null;
  const rotatedAt = merchant?.webhookSecretRotatedAt || memory?.webhookSecretRotatedAt || null;

  if (!prefix) {
    return {
      webhookUrl,
      secretInfo: null,
    };
  }

  return {
    webhookUrl,
    secretInfo: {
      prefix,
      lastChars,
      rotatedAt: rotatedAt instanceof Date ? rotatedAt.toISOString() : (rotatedAt || new Date().toISOString()),
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

  try {
    await prisma.merchant.update({
      where: { id: merchantId },
      data: { webhookUrl },
    });
  } catch (err: any) {
    logger.warn(`[SecretService] DB updateWebhookUrl failed: ${err.message}`);
  }

  const memory = memorySecrets.get(merchantId) || {};
  memory.webhookUrl = webhookUrl;
  memorySecrets.set(merchantId, memory);

  const memMerchant = memoryMerchants.get(merchantId);
  if (memMerchant) {
    memMerchant.webhookUrl = webhookUrl;
  }

  return { success: true, webhookUrl };
}
