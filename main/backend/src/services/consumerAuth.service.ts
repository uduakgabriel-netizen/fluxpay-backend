import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import jwt from 'jsonwebtoken';
import {
  generateNonceString,
  storeConsumerNonce,
  getConsumerNonce,
  deleteConsumerNonce,
  isValidSolanaAddress,
  NONCE_TTL_MS,
} from '../utils/consumerNonce';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();
const getJwtSecret = () => process.env.JWT_SECRET || 'fallback-secret-change-me';
const getJwtExpiresIn = () => process.env.JWT_EXPIRES_IN || '7d';

export class ConsumerAuthError extends Error {
  statusCode: number;
  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = 'ConsumerAuthError';
    this.message = message;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, ConsumerAuthError.prototype);
  }
}

export interface ConsumerNonceResult {
  nonce: string;
  expiresAt: string;
}

export interface ConsumerLoginResult {
  token: string;
  user: {
    id: string;
    walletAddress: string;
  };
}

export interface ConsumerProfileResult {
  id: string;
  walletAddress: string;
  createdAt: string;
}

/**
 * Generate a 32-byte hex nonce with 5-minute TTL for consumer wallet
 */
export async function generateConsumerNonce(
  walletAddress: string
): Promise<ConsumerNonceResult> {
  const normalizedWallet = walletAddress.trim();

  if (!isValidSolanaAddress(normalizedWallet)) {
    throw new ConsumerAuthError('Invalid wallet address', 400);
  }

  const nonce = generateNonceString();
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS);

  await storeConsumerNonce(normalizedWallet, nonce, expiresAt);

  return {
    nonce,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Verify wallet signature, upsert consumer User record, and issue JWT
 */
export async function verifyConsumerSignature(
  walletAddress: string,
  signature: string
): Promise<ConsumerLoginResult> {
  const normalizedWallet = walletAddress.trim();

  if (!isValidSolanaAddress(normalizedWallet)) {
    throw new ConsumerAuthError('Invalid wallet address', 400);
  }

  // 1. Retrieve stored nonce for wallet + role "consumer"
  const storedNonce = await getConsumerNonce(normalizedWallet);
  if (!storedNonce) {
    throw new ConsumerAuthError('Nonce expired or not found', 401);
  }

  // 2. Decode signature and public key
  let signatureBytes: Uint8Array;
  try {
    const rawSig = signature.trim();
    try {
      signatureBytes = bs58.decode(rawSig);
    } catch {
      // Fallback: try base64 if client passed base64 encoded signature
      const buf = Buffer.from(rawSig, 'base64');
      if (buf.length === 64) {
        signatureBytes = new Uint8Array(buf);
      } else {
        throw new Error('Invalid signature format');
      }
    }

    if (signatureBytes.length !== 64) {
      throw new Error('Invalid signature length');
    }
  } catch (err) {
    logger.warn('[consumerAuth] Signature decode failed:', err);
    throw new ConsumerAuthError('Invalid signature', 401);
  }

  let publicKeyBytes: Uint8Array;
  try {
    publicKeyBytes = bs58.decode(normalizedWallet);
    if (publicKeyBytes.length !== 32) {
      throw new Error('Invalid public key length');
    }
  } catch (err) {
    throw new ConsumerAuthError('Invalid wallet address', 400);
  }

  // 3. Verify signature using tweetnacl
  // Standard format: raw nonce bytes
  const messageBytes = new TextEncoder().encode(storedNonce);
  let isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);

  // Fallback: formatted prefix message if raw message wasn't signed
  if (!isValid) {
    const fallbackMessageBytes = new TextEncoder().encode(
      `Sign this message to verify your wallet: ${storedNonce}`
    );
    isValid = nacl.sign.detached.verify(fallbackMessageBytes, signatureBytes, publicKeyBytes);
  }

  if (!isValid) {
    throw new ConsumerAuthError('Invalid signature', 401);
  }

  // 4. Invalidate nonce (single-use only)
  await deleteConsumerNonce(normalizedWallet);

  // 5. Upsert consumer User record (with in-memory fallback if DB is offline)
  let user: { id: string; walletAddress: string; createdAt?: Date };
  try {
    const dbUser = await prisma.user.upsert({
      where: { walletAddress: normalizedWallet },
      update: { updatedAt: new Date() },
      create: { walletAddress: normalizedWallet },
    });
    user = {
      id: dbUser.id,
      walletAddress: dbUser.walletAddress,
      createdAt: dbUser.createdAt,
    };
    memoryUsers.set(user.id, {
      id: user.id,
      walletAddress: user.walletAddress,
      createdAt: dbUser.createdAt,
    });
  } catch (dbErr) {
    logger.warn('[consumerAuth] Database unavailable, falling back to in-memory user store:', dbErr);
    let existing = Array.from(memoryUsers.values()).find(
      (u) => u.walletAddress === normalizedWallet
    );
    if (!existing) {
      existing = {
        id: `usr_${randomBytes(8).toString('hex')}`,
        walletAddress: normalizedWallet,
        createdAt: new Date(),
      };
      memoryUsers.set(existing.id, existing);
    }
    user = existing;
  }

  // 6. Generate JWT (payload: { id, role: 'consumer' } - no wallet address in JWT)
  const token = jwt.sign(
    {
      id: user.id,
      role: 'consumer',
    },
    getJwtSecret(),
    {
      expiresIn: getJwtExpiresIn() as jwt.SignOptions['expiresIn'],
    }
  );

  return {
    token,
    user: {
      id: user.id,
      walletAddress: user.walletAddress,
    },
  };
}

// In-memory user fallback map for offline development mode
const memoryUsers = new Map<
  string,
  { id: string; walletAddress: string; createdAt: Date }
>();

/**
 * Retrieve consumer profile by user ID
 */
export async function getConsumerProfile(
  userId: string
): Promise<ConsumerProfileResult> {
  let user: { id: string; walletAddress: string; createdAt: Date } | null = null;

  try {
    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
    });
    if (dbUser) {
      user = {
        id: dbUser.id,
        walletAddress: dbUser.walletAddress,
        createdAt: dbUser.createdAt,
      };
    }
  } catch (dbErr) {
    logger.warn('[consumerAuth] Database error, checking in-memory user store:', dbErr);
  }

  if (!user) {
    user = memoryUsers.get(userId) || null;
  }

  if (!user) {
    throw new ConsumerAuthError('User not found', 404);
  }

  return {
    id: user.id,
    walletAddress: user.walletAddress,
    createdAt: user.createdAt.toISOString(),
  };
}
