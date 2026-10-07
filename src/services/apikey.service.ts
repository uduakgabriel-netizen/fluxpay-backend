import { PrismaClient, ApiKeyMode } from '@prisma/client';
import { randomBytes, createHash } from 'crypto';
import { AppError } from './auth.service';

const prisma = new PrismaClient();

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

  // Create record
  const apiKey = await prisma.apiKey.create({
    data: {
      merchantId,
      keyHash,
      keyPrefix,
      name,
      mode,
      permissions,
    },
  });

  // Return the raw key ONLY this one time
  return {
    id: apiKey.id,
    key: rawKey, // ⚠️ Only returned once — never stored or retrievable again
    keyPrefix: apiKey.keyPrefix,
    name: apiKey.name,
    mode: apiKey.mode,
    permissions: apiKey.permissions,
    createdAt: apiKey.createdAt.toISOString(),
    message: 'Store this key securely. It will not be shown again.',
  };
}

// ─── List API Keys ──────────────────────────────────────────

export async function listApiKeys(merchantId: string) {
  const keys = await prisma.apiKey.findMany({
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

  return {
    data: keys.map((k) => ({
      ...k,
      // Show masked version: sk_live_****...****
      maskedKey: `${k.keyPrefix}${'*'.repeat(8)}...${' '.repeat(0)}`,
      lastUsed: k.lastUsed?.toISOString() || null,
      revokedAt: k.revokedAt?.toISOString() || null,
      createdAt: k.createdAt.toISOString(),
    })),
    total: keys.length,
  };
}

// ─── Revoke API Key ─────────────────────────────────────────

export async function revokeApiKey(keyId: string, merchantId: string) {
  const apiKey = await prisma.apiKey.findFirst({
    where: {
      id: keyId,
      merchantId,
    },
  });

  if (!apiKey) {
    throw new AppError('API key not found', 404);
  }

  if (apiKey.revoked) {
    throw new AppError('API key is already revoked', 400);
  }

  await prisma.apiKey.update({
    where: { id: keyId },
    data: {
      revoked: true,
      revokedAt: new Date(),
    },
  });

  return {
    id: keyId,
    revoked: true,
    revokedAt: new Date().toISOString(),
    message: 'API key has been permanently revoked.',
  };
}

// ─── API Key Stats ──────────────────────────────────────────

export async function getApiKeyStats(keyId: string, merchantId: string) {
  const apiKey = await prisma.apiKey.findFirst({
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

  if (!apiKey) {
    throw new AppError('API key not found', 404);
  }

  // Calculate age
  const ageMs = Date.now() - apiKey.createdAt.getTime();
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));

  return {
    ...apiKey,
    maskedKey: `${apiKey.keyPrefix}${'*'.repeat(8)}...`,
    lastUsed: apiKey.lastUsed?.toISOString() || null,
    revokedAt: apiKey.revokedAt?.toISOString() || null,
    createdAt: apiKey.createdAt.toISOString(),
    ageDays,
    averageRequestsPerDay: ageDays > 0 ? Math.round(apiKey.requestCount / ageDays) : apiKey.requestCount,
  };
}
