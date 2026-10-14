import { PrismaClient, ApiKeyMode } from '@prisma/client';
import { randomBytes, createHash } from 'crypto';
import { AppError, memoryMerchants } from './auth.service';
import { apiKeyToMerchantMap, memorySecrets, revokeApiKey as revokeLegacyApiKey } from './secret.service';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

// In-memory store for ApiKey objects
export interface MemoryApiKeyRecord {
  id: string;
  merchantId: string;
  keyHash: string;
  keyPrefix: string;
  name: string;
  mode: ApiKeyMode;
  permissions: { read: boolean; write: boolean; refund: boolean };
  lastUsed?: Date | null;
  lastIp?: string | null;
  requestCount: number;
  revoked: boolean;
  revokedAt?: Date | null;
  createdAt: Date;
}

export const memoryApiKeys = new Map<string, MemoryApiKeyRecord>();

// Pre-seed demo live API key
memoryApiKeys.set('key_live_demo', {
  id: 'key_live_demo',
  merchantId: 'merchant_live',
  keyHash: 'ecff9540b8578dd4f1190c3235708d15dcd55e6fd8e0203f7cbd4803ee0817b5',
  keyPrefix: 'sk_live_',
  name: 'Demo Store Key',
  mode: 'LIVE' as ApiKeyMode,
  permissions: { read: true, write: true, refund: true },
  lastUsed: new Date(),
  lastIp: null,
  requestCount: 0,
  revoked: false,
  revokedAt: null,
  createdAt: new Date(),
});

// ─── Key Generation ─────────────────────────────────────────

/**
 * Generate a cryptographically random API key with the proper prefix
 * Format: sk_live_<40 hex chars> or sk_test_<40 hex chars>
 */
function generateRawKey(mode: ApiKeyMode): string {
  const prefix = mode === 'LIVE' ? 'sk_live_' : 'sk_test_';
  const random = randomBytes(20).toString('hex'); // 40 hex chars
  return `${prefix}${random}`;
}

/**
 * Hash an API key for storage (SHA-256)
 */
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// ─── Create API Key ─────────────────────────────────────────

interface CreateApiKeyInput {
  merchantId: string;
  name: string;
  mode: ApiKeyMode;
  permissions: { read: boolean; write: boolean; refund: boolean };
}

export async function createApiKey(input: CreateApiKeyInput) {
  const { merchantId, name, mode, permissions } = input;

  // Generate the raw key
  const rawKey = generateRawKey(mode);
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 8); // e.g., "sk_live_"
  const now = new Date();

  let createdKey: any = null;
  try {
    createdKey = await prisma.apiKey.create({
      data: {
        merchantId,
        keyHash,
        keyPrefix,
        name,
        mode,
        permissions,
      },
    });
  } catch (err: any) {
    logger.warn(`[ApiKeyService] DB create apiKey failed, using memory store: ${err.message}`);
  }

  const keyId = createdKey?.id || `key_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  // Store in memory
  const memoryRecord: MemoryApiKeyRecord = {
    id: keyId,
    merchantId,
    keyHash,
    keyPrefix,
    name,
    mode,
    permissions,
    lastUsed: null,
    lastIp: null,
    requestCount: 0,
    revoked: false,
    revokedAt: null,
    createdAt: createdKey?.createdAt || now,
  };
  memoryApiKeys.set(keyId, memoryRecord);

  // Register in quick lookup map
  const memMerchant = memoryMerchants.get(merchantId);
  apiKeyToMerchantMap.set(keyHash, {
    id: merchantId,
    walletAddress: memMerchant?.walletAddress || '7J5tPd33wXDFVcFvgPJdhiTrG3qxvJbCp1JiQZET3NFh',
    email: memMerchant?.email || 'merchant@fluxpay.io',
    businessName: memMerchant?.businessName || 'FluxPay Merchant',
  });

  // Return the raw key ONLY this one time
  return {
    id: keyId,
    key: rawKey, // ⚠️ Only returned once — never stored or retrievable again
    keyPrefix,
    name,
    mode,
    permissions,
    createdAt: (createdKey?.createdAt || now).toISOString(),
    message: 'Store this key securely. It will not be shown again.',
  };
}

// ─── List API Keys ──────────────────────────────────────────

export async function listApiKeys(merchantId: string) {
  let keys: any[] = [];
  try {
    keys = await prisma.apiKey.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        keyPrefix: true,
        name: true,
        mode: true,
        permissions: true,
        lastUsed: true,
        lastIp: true,
        requestCount: true,
        revoked: true,
        revokedAt: true,
        createdAt: true,
      },
    });
  } catch (err: any) {
    logger.warn(`[ApiKeyService] DB listApiKeys failed: ${err.message}`);
  }

  // Merge in-memory keys
  const memKeys = Array.from(memoryApiKeys.values()).filter((k) => k.merchantId === merchantId);
  const existingIds = new Set(keys.map((k) => k.id));
  for (const mk of memKeys) {
    if (!existingIds.has(mk.id)) {
      keys.push(mk);
    }
  }

  // If no keys exist, check if merchant has a legacy primary key
  if (keys.length === 0) {
    let merchant: any = null;
    try {
      merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
        select: { apiKeyPrefix: true, apiKeyLastChars: true, apiKeyRotatedAt: true, createdAt: true },
      });
    } catch {}
    const mem = memorySecrets.get(merchantId) || memoryMerchants.get(merchantId);
    const prefix = merchant?.apiKeyPrefix || mem?.apiKeyPrefix;
    if (prefix) {
      const lastChars = merchant?.apiKeyLastChars || mem?.apiKeyLastChars || '';
      keys.push({
        id: 'legacy-primary',
        keyPrefix: prefix,
        maskedKey: `${prefix}••••••••••••••••${lastChars}`,
        name: 'Default API Key',
        mode: prefix.toLowerCase().includes('test') ? 'TEST' : 'LIVE',
        permissions: { read: true, write: true, refund: false },
        lastUsed: null,
        lastIp: null,
        requestCount: 0,
        revoked: false,
        revokedAt: null,
        createdAt: merchant?.apiKeyRotatedAt || mem?.apiKeyRotatedAt || merchant?.createdAt || new Date(),
      });
    }
  }

  return {
    data: keys.map((k) => ({
      ...k,
      maskedKey: k.maskedKey || `${k.keyPrefix}••••••••••••••••`,
      lastUsed: k.lastUsed ? (k.lastUsed instanceof Date ? k.lastUsed.toISOString() : k.lastUsed) : null,
      revokedAt: k.revokedAt ? (k.revokedAt instanceof Date ? k.revokedAt.toISOString() : k.revokedAt) : null,
      createdAt: k.createdAt instanceof Date ? k.createdAt.toISOString() : (k.createdAt || new Date().toISOString()),
    })),
    total: keys.length,
  };
}

// ─── Revoke API Key ─────────────────────────────────────────

export async function revokeApiKey(keyId: string, merchantId: string) {
  const now = new Date();

  if (keyId === 'legacy-primary') {
    await revokeLegacyApiKey(merchantId);
    return {
      id: keyId,
      revoked: true,
      revokedAt: now.toISOString(),
      message: 'API key has been permanently revoked.',
    };
  }

  let apiKey: any = null;
  try {
    apiKey = await prisma.apiKey.findFirst({
      where: {
        id: keyId,
        merchantId,
      },
    });
  } catch (err: any) {
    logger.warn(`[ApiKeyService] DB find apiKey failed: ${err.message}`);
  }

  if (!apiKey) {
    apiKey = memoryApiKeys.get(keyId);
    if (!apiKey || apiKey.merchantId !== merchantId) {
      throw new AppError('API key not found', 404);
    }
  }

  if (apiKey.revoked) {
    throw new AppError('API key is already revoked', 400);
  }

  try {
    await prisma.apiKey.update({
      where: { id: keyId },
      data: {
        revoked: true,
        revokedAt: now,
      },
    });
  } catch (err: any) {
    logger.warn(`[ApiKeyService] DB update revoke failed: ${err.message}`);
  }

  if (memoryApiKeys.has(keyId)) {
    const mem = memoryApiKeys.get(keyId)!;
    mem.revoked = true;
    mem.revokedAt = now;
    apiKeyToMerchantMap.delete(mem.keyHash);
  }

  return {
    id: keyId,
    revoked: true,
    revokedAt: now.toISOString(),
    message: 'API key has been permanently revoked.',
  };
}

// ─── API Key Stats ──────────────────────────────────────────

export async function getApiKeyStats(keyId: string, merchantId: string) {
  let apiKey: any = null;
  try {
    apiKey = await prisma.apiKey.findFirst({
      where: {
        id: keyId,
        merchantId,
      },
      select: {
        id: true,
        keyPrefix: true,
        name: true,
        mode: true,
        permissions: true,
        lastUsed: true,
        lastIp: true,
        requestCount: true,
        revoked: true,
        revokedAt: true,
        createdAt: true,
      },
    });
  } catch (err: any) {
    logger.warn(`[ApiKeyService] DB getApiKeyStats failed: ${err.message}`);
  }

  if (!apiKey) {
    apiKey = memoryApiKeys.get(keyId);
    if (!apiKey || apiKey.merchantId !== merchantId) {
      throw new AppError('API key not found', 404);
    }
  }

  const createdTime = apiKey.createdAt instanceof Date ? apiKey.createdAt.getTime() : new Date(apiKey.createdAt).getTime();
  const ageMs = Date.now() - createdTime;
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));

  return {
    ...apiKey,
    maskedKey: `${apiKey.keyPrefix}${'*'.repeat(8)}...`,
    lastUsed: apiKey.lastUsed ? (apiKey.lastUsed instanceof Date ? apiKey.lastUsed.toISOString() : apiKey.lastUsed) : null,
    revokedAt: apiKey.revokedAt ? (apiKey.revokedAt instanceof Date ? apiKey.revokedAt.toISOString() : apiKey.revokedAt) : null,
    createdAt: apiKey.createdAt instanceof Date ? apiKey.createdAt.toISOString() : apiKey.createdAt,
    ageDays,
    averageRequestsPerDay: ageDays > 0 ? Math.round(apiKey.requestCount / ageDays) : apiKey.requestCount,
  };
}
