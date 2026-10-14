import { randomBytes } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import { PrismaClient } from '@prisma/client';
import { logger } from './logger';

const prisma = new PrismaClient();

export interface StoredConsumerNonce {
  nonce: string;
  expiresAt: Date;
  role: 'consumer';
}

// In-memory cache for fast nonce access and TTL handling
const nonceCache = new Map<string, StoredConsumerNonce>();

// 5 minutes TTL in milliseconds
export const NONCE_TTL_MS = 5 * 60 * 1000;

/**
 * Validate that a string is a valid Solana public key (base58 on curve)
 */
export function isValidSolanaAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false;
  try {
    const pubkey = new PublicKey(address.trim());
    return PublicKey.isOnCurve(pubkey.toBytes());
  } catch {
    return false;
  }
}

/**
 * Generate a cryptographically secure random nonce (32 bytes, hex-encoded)
 */
export function generateNonceString(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Store a consumer nonce with 5-minute TTL (in memory cache + database)
 */
export async function storeConsumerNonce(
  walletAddress: string,
  nonce: string,
  expiresAt: Date
): Promise<void> {
  const normalizedWallet = walletAddress.trim();
  const cacheKey = `consumer:${normalizedWallet}`;

  // 1. Store in memory cache
  nonceCache.set(cacheKey, {
    nonce,
    expiresAt,
    role: 'consumer',
  });

  // 2. Persist to database for cross-instance support
  try {
    await prisma.consumerNonce.upsert({
      where: { walletAddress: normalizedWallet },
      update: { nonce, expiresAt },
      create: { walletAddress: normalizedWallet, nonce, expiresAt },
    });
  } catch (err) {
    logger.warn('[consumerNonce] DB persistence fallback to cache only:', err);
  }
}

/**
 * Retrieve the stored nonce for a wallet and role 'consumer'
 * Returns null if not found or expired
 */
export async function getConsumerNonce(walletAddress: string): Promise<string | null> {
  const normalizedWallet = walletAddress.trim();
  const cacheKey = `consumer:${normalizedWallet}`;
  const now = new Date();

  // 1. Check in-memory cache first
  const cached = nonceCache.get(cacheKey);
  if (cached) {
    if (now > cached.expiresAt) {
      nonceCache.delete(cacheKey);
      await deleteConsumerNonce(normalizedWallet).catch(() => {});
      return null;
    }
    return cached.nonce;
  }

  // 2. Check database
  try {
    const dbRecord = await prisma.consumerNonce.findUnique({
      where: { walletAddress: normalizedWallet },
    });

    if (!dbRecord) {
      return null;
    }

    if (now > dbRecord.expiresAt) {
      await deleteConsumerNonce(normalizedWallet).catch(() => {});
      return null;
    }

    // Refresh cache from DB
    nonceCache.set(cacheKey, {
      nonce: dbRecord.nonce,
      expiresAt: dbRecord.expiresAt,
      role: 'consumer',
    });

    return dbRecord.nonce;
  } catch (err) {
    logger.error('[consumerNonce] Error retrieving nonce from DB:', err);
    return null;
  }
}

/**
 * Delete a consumer nonce (invalidate after single use or expiry)
 */
export async function deleteConsumerNonce(walletAddress: string): Promise<void> {
  const normalizedWallet = walletAddress.trim();
  const cacheKey = `consumer:${normalizedWallet}`;

  // Delete from in-memory cache
  nonceCache.delete(cacheKey);

  // Delete from database
  try {
    await prisma.consumerNonce.deleteMany({
      where: { walletAddress: normalizedWallet },
    });
  } catch (err) {
    logger.warn('[consumerNonce] Error deleting nonce from DB:', err);
  }
}
