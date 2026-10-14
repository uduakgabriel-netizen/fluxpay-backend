import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { generateNonce, verifyWalletSignature } from '../utils/crypto';
import { generateToken, getSessionExpiry } from '../utils/jwt';
import TokenService from './token.service';
import { getTokenBySymbol } from '../utils/token-registry';
import { AppError } from '../errors/AppError';
import { logger } from '../utils/logger';
import {
  AuthResponse,
  NonceResponse,
  MeResponse,
  SignupRequestBody,
  VerifyRequestBody,
} from '../types/auth.types';

const prisma = new PrismaClient();
const SALT_ROUNDS = 10;
const NONCE_EXPIRY_MINUTES = 5;

// In-memory fallbacks for local dev or when PostgreSQL is unreachable
export interface MemoryNonce {
  id: string;
  walletAddress: string;
  nonce: string;
  expiresAt: Date;
}

export const memoryNonces = new Map<string, MemoryNonce>();
import crypto from 'crypto';

export const memoryMerchants = new Map<string, any>();
export const memorySessions = new Map<string, any>();

const activeApiKey = process.env.FLUXPAY_API_KEY || 'flux_demo_merchant_key_2026';
const activeApiKeyHash = crypto.createHash('sha256').update(activeApiKey).digest('hex');
const activeWebhookSecret = process.env.FLUXPAY_WEBHOOK_SECRET || 'whsec_0f9c0a8271e4792feeade69df3f51c221f4eb9fa05658050';

// Pre-seed merchant_live for demo resilience across server restarts
memoryMerchants.set('merchant_live', {
  id: 'merchant_live',
  walletAddress: '7J5tPd33wXDFVcFvgPJdhiTrG3qxvJbCp1JiQZET3NFh',
  email: 'merchant@fluxpay.io',
  businessName: 'SHOEPLACE.NG',
  apiKeyHash: activeApiKeyHash,
  webhookSecret: activeWebhookSecret,
  webhookUrl: 'http://localhost:3002/api/webhooks/fluxpay',
});

// Also register previous key hash for backward compatibility
memoryMerchants.set('merchant_live_legacy', {
  id: 'merchant_live',
  walletAddress: '7J5tPd33wXDFVcFvgPJdhiTrG3qxvJbCp1JiQZET3NFh',
  email: 'merchant@fluxpay.io',
  businessName: 'SHOEPLACE.NG',
  apiKeyHash: 'ecff9540b8578dd4f1190c3235708d15dcd55e6fd8e0203f7cbd4803ee0817b5',
  webhookSecret: activeWebhookSecret,
  webhookUrl: 'http://localhost:3002/api/webhooks/fluxpay',
});

/**
 * Generate a nonce for wallet signature verification
 */
export async function createNonce(walletAddress: string): Promise<NonceResponse> {
  const nonce = generateNonce();
  const expiresAt = new Date(Date.now() + NONCE_EXPIRY_MINUTES * 60 * 1000);

  // Try DB upsert
  try {
    await prisma.nonce.upsert({
      where: { walletAddress },
      update: { nonce, expiresAt },
      create: { walletAddress, nonce, expiresAt },
    });
  } catch (err: any) {
    logger.warn(`[AuthService] DB upsert nonce failed, using memory fallback: ${err.message}`);
  }

  // Always store in memory fallback
  memoryNonces.set(walletAddress, {
    id: 'nonce_' + Date.now(),
    walletAddress,
    nonce,
    expiresAt,
  });

  return {
    nonce,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Verify wallet signature and create/find merchant session
 */
export async function verifyAndLogin(data: VerifyRequestBody): Promise<AuthResponse> {
  const { walletAddress, message, signature } = data;

  // 1. Fetch nonce from DB or memory fallback
  let nonceRecord: any = null;
  try {
    nonceRecord = await prisma.nonce.findUnique({
      where: { walletAddress },
    });
  } catch (err: any) {
    logger.warn(`[AuthService] DB find nonce failed: ${err.message}`);
  }

  if (!nonceRecord) {
    nonceRecord = memoryNonces.get(walletAddress) || null;
  }

  if (!nonceRecord) {
    throw new AppError('No nonce found. Please request a new nonce first.', 400);
  }

  // 2. Check nonce expiry
  if (new Date() > new Date(nonceRecord.expiresAt)) {
    try {
      if (nonceRecord.id && !nonceRecord.id.startsWith('nonce_')) {
        await prisma.nonce.delete({ where: { id: nonceRecord.id } });
      }
    } catch {}
    memoryNonces.delete(walletAddress);
    throw new AppError('Nonce has expired. Please request a new one.', 400);
  }

  // 3. Verify the message contains the correct nonce
  const expectedMessage = `Sign this message to verify your wallet: ${nonceRecord.nonce}`;
  if (message !== expectedMessage) {
    throw new AppError('Invalid message format.', 400);
  }

  // 4. Verify signature
  const isValid = verifyWalletSignature(message, signature, walletAddress);
  if (!isValid) {
    throw new AppError('Invalid wallet signature.', 401);
  }

  // 5. Delete used nonce
  try {
    if (nonceRecord.id && !nonceRecord.id.startsWith('nonce_')) {
      await prisma.nonce.delete({ where: { id: nonceRecord.id } });
    }
  } catch {}
  memoryNonces.delete(walletAddress);

  // 6. Find or create merchant
  let merchant: any = null;
  try {
    merchant = await prisma.merchant.findUnique({
      where: { walletAddress },
    });
  } catch (err: any) {
    logger.warn(`[AuthService] DB find merchant failed: ${err.message}`);
  }

  if (!merchant) {
    merchant = memoryMerchants.get(walletAddress) || null;
  }

  if (!merchant) {
    const defaultData = {
      id: 'merchant_' + walletAddress.slice(0, 8),
      walletAddress,
      email: `${walletAddress.slice(0, 8)}@wallet.fluxpay.io`,
      businessName: `Merchant ${walletAddress.slice(0, 6)}`,
      preferredTokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      preferredTokenSymbol: 'USDC',
      preferredTokenDecimals: 6,
      hasSelectedToken: true,
      emailVerified: true,
      createdAt: new Date(),
    };

    try {
      merchant = await prisma.merchant.create({
        data: {
          walletAddress: defaultData.walletAddress,
          email: defaultData.email,
          businessName: defaultData.businessName,
        },
      });
    } catch (err: any) {
      logger.warn(`[AuthService] DB create merchant failed, using memory: ${err.message}`);
      merchant = defaultData;
    }
  }

  // Cache merchant
  memoryMerchants.set(walletAddress, merchant);
  memoryMerchants.set(merchant.id, merchant);

  // 7. Generate session
  const tokenPayload = {
    id: merchant.id,
    walletAddress: merchant.walletAddress,
    email: merchant.email,
    businessName: merchant.businessName,
    role: 'merchant',
  };

  const sessionToken = generateToken(tokenPayload);
  const expiresAt = getSessionExpiry();

  try {
    await prisma.session.create({
      data: {
        merchantId: merchant.id,
        token: sessionToken,
        expiresAt,
      },
    });
  } catch (err: any) {
    logger.warn(`[AuthService] DB create session failed, using memory fallback: ${err.message}`);
  }

  memorySessions.set(sessionToken, {
    token: sessionToken,
    merchantId: merchant.id,
    merchant,
    expiresAt,
  });

  return {
    sessionToken,
    merchant: {
      id: merchant.id,
      walletAddress: merchant.walletAddress,
      email: merchant.email,
      businessName: merchant.businessName,
      preferredTokenMint: merchant.preferredTokenMint || undefined,
      preferredTokenSymbol: merchant.preferredTokenSymbol || undefined,
      preferredTokenDecimals: merchant.preferredTokenDecimals || undefined,
      hasSelectedToken: merchant.hasSelectedToken,
      preferredTokenUpdatedAt: merchant.preferredTokenUpdatedAt
        ? new Date(merchant.preferredTokenUpdatedAt).toISOString()
        : undefined,
    },
  };
}

/**
 * Sign up a new merchant with wallet + email + business name + preferred token
 */
export async function signup(data: SignupRequestBody): Promise<AuthResponse> {
  const { walletAddress, email, businessName, message, signature, preferredTokenSymbol } = data;

  // 0. Validate token preference is provided
  if (!preferredTokenSymbol) {
    throw new AppError('Please select a settlement token', 400);
  }

  // 0.5. Validate token is supported
  const tokenInfo = getTokenBySymbol(preferredTokenSymbol);
  if (!tokenInfo) {
    throw new AppError(`Token ${preferredTokenSymbol} is not supported`, 400);
  }

  // 1. Fetch and validate nonce
  let nonceRecord: any = null;
  try {
    nonceRecord = await prisma.nonce.findUnique({
      where: { walletAddress },
    });
  } catch {}

  if (!nonceRecord) {
    nonceRecord = memoryNonces.get(walletAddress) || null;
  }

  if (!nonceRecord) {
    throw new AppError('No nonce found. Please request a new nonce first.', 400);
  }

  if (new Date() > new Date(nonceRecord.expiresAt)) {
    try {
      if (nonceRecord.id && !nonceRecord.id.startsWith('nonce_')) {
        await prisma.nonce.delete({ where: { id: nonceRecord.id } });
      }
    } catch {}
    memoryNonces.delete(walletAddress);
    throw new AppError('Nonce has expired. Please request a new one.', 400);
  }

  // 2. Verify message format
  const expectedMessage = `Sign this message to verify your wallet: ${nonceRecord.nonce}`;
  if (message !== expectedMessage) {
    throw new AppError('Invalid message format.', 400);
  }

  // 3. Verify signature
  const isValid = verifyWalletSignature(message, signature, walletAddress);
  if (!isValid) {
    throw new AppError('Invalid wallet signature.', 401);
  }

  // 4. Delete used nonce
  try {
    if (nonceRecord.id && !nonceRecord.id.startsWith('nonce_')) {
      await prisma.nonce.delete({ where: { id: nonceRecord.id } });
    }
  } catch {}
  memoryNonces.delete(walletAddress);

  // 5. Check if wallet already exists
  let existingWallet: any = null;
  try {
    existingWallet = await prisma.merchant.findUnique({
      where: { walletAddress },
    });
  } catch {}

  if (!existingWallet) {
    existingWallet = memoryMerchants.get(walletAddress) || null;
  }

  if (existingWallet) {
    throw new AppError('A merchant with this wallet address already exists.', 409);
  }

  // 6. Check if email already exists
  if (email && email.trim() !== '') {
    let existingEmail: any = null;
    try {
      existingEmail = await prisma.merchant.findFirst({
        where: { email },
      });
    } catch {}

    if (existingEmail) {
      throw new AppError('A merchant with this email already exists.', 409);
    }
  }

  // 7. Create merchant
  const newMerchant = {
    id: 'merchant_' + walletAddress.slice(0, 8),
    walletAddress,
    email: email && email.trim() !== '' ? email : null,
    businessName,
    preferredTokenMint: tokenInfo.mintAddress,
    preferredTokenSymbol: tokenInfo.symbol,
    preferredTokenDecimals: tokenInfo.decimals,
    hasSelectedToken: true,
    emailVerified: false,
    createdAt: new Date(),
    preferredTokenUpdatedAt: new Date(),
  };

  let merchant = newMerchant;
  try {
    merchant = await prisma.merchant.create({
      data: {
        walletAddress,
        email: email && email.trim() !== '' ? email : null,
        businessName,
        preferredTokenMint: tokenInfo.mintAddress,
        preferredTokenSymbol: tokenInfo.symbol,
        preferredTokenDecimals: tokenInfo.decimals,
        hasSelectedToken: true,
        preferredTokenUpdatedAt: new Date(),
      },
    });
  } catch (err: any) {
    logger.warn(`[AuthService] DB signup merchant creation failed, using memory: ${err.message}`);
  }

  memoryMerchants.set(walletAddress, merchant);
  memoryMerchants.set(merchant.id, merchant);

  // 8. Generate session
  const tokenPayload = {
    id: merchant.id,
    walletAddress: merchant.walletAddress,
    email: merchant.email,
    businessName: merchant.businessName,
    role: 'merchant',
  };

  const sessionToken = generateToken(tokenPayload);
  const expiresAt = getSessionExpiry();

  try {
    await prisma.session.create({
      data: {
        merchantId: merchant.id,
        token: sessionToken,
        expiresAt,
      },
    });
  } catch (err: any) {
    logger.warn(`[AuthService] DB session creation failed, using memory: ${err.message}`);
  }

  memorySessions.set(sessionToken, {
    token: sessionToken,
    merchantId: merchant.id,
    merchant,
    expiresAt,
  });

  return {
    sessionToken,
    merchant: {
      id: merchant.id,
      walletAddress: merchant.walletAddress,
      email: merchant.email,
      businessName: merchant.businessName,
      preferredTokenMint: merchant.preferredTokenMint,
      preferredTokenSymbol: merchant.preferredTokenSymbol,
      preferredTokenDecimals: merchant.preferredTokenDecimals,
      hasSelectedToken: merchant.hasSelectedToken,
      preferredTokenUpdatedAt: merchant.preferredTokenUpdatedAt
        ? new Date(merchant.preferredTokenUpdatedAt).toISOString()
        : undefined,
    },
  };
}

/**
 * Get current merchant info
 */
export async function getMe(merchantId: string): Promise<MeResponse> {
  let merchant: any = null;
  try {
    merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
    });
  } catch (err: any) {
    logger.warn(`[AuthService] DB getMe failed, checking memory fallback: ${err.message}`);
  }

  if (!merchant) {
    merchant = memoryMerchants.get(merchantId) || null;
  }

  if (!merchant) {
    merchant = {
      id: merchantId,
      walletAddress: '',
      email: `${merchantId}@wallet.fluxpay.io`,
      businessName: 'Solana Merchant',
      emailVerified: true,
      hasSelectedToken: true,
      preferredTokenSymbol: 'USDC',
      createdAt: new Date(),
    };
  }

  return {
    id: merchant.id,
    walletAddress: merchant.walletAddress || '',
    email: merchant.email || '',
    businessName: merchant.businessName || 'Solana Merchant',
    emailVerified: Boolean(merchant.emailVerified),
    createdAt: merchant.createdAt ? new Date(merchant.createdAt).toISOString() : new Date().toISOString(),
    preferredTokenMint: merchant.preferredTokenMint || undefined,
    preferredTokenSymbol: merchant.preferredTokenSymbol || undefined,
    preferredTokenDecimals: merchant.preferredTokenDecimals || undefined,
    hasSelectedToken: merchant.hasSelectedToken ?? true,
    preferredTokenUpdatedAt: merchant.preferredTokenUpdatedAt
      ? new Date(merchant.preferredTokenUpdatedAt).toISOString()
      : undefined,
  };
}

/**
 * Update merchant profile
 */
export async function updateProfile(
  merchantId: string,
  data: { businessName?: string; email?: string }
): Promise<MeResponse> {
  let merchant = memoryMerchants.get(merchantId) || null;
  try {
    merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
    });
  } catch {}

  if (!merchant) {
    merchant = {
      id: merchantId,
      walletAddress: '',
      email: `${merchantId}@wallet.fluxpay.io`,
      businessName: 'Solana Merchant',
      createdAt: new Date(),
    };
  }

  const updatedMerchant = {
    ...merchant,
    ...(data.businessName && { businessName: data.businessName }),
    ...(data.email && { email: data.email, emailVerified: false }),
  };

  try {
    await prisma.merchant.update({
      where: { id: merchantId },
      data: {
        ...(data.businessName && { businessName: data.businessName }),
        ...(data.email && { email: data.email, emailVerified: false }),
      },
    });
  } catch {}

  memoryMerchants.set(merchantId, updatedMerchant);
  if (updatedMerchant.walletAddress) {
    memoryMerchants.set(updatedMerchant.walletAddress, updatedMerchant);
  }

  return {
    id: updatedMerchant.id,
    walletAddress: updatedMerchant.walletAddress,
    email: updatedMerchant.email,
    businessName: updatedMerchant.businessName,
    emailVerified: updatedMerchant.emailVerified,
    createdAt: updatedMerchant.createdAt ? new Date(updatedMerchant.createdAt).toISOString() : new Date().toISOString(),
  };
}

/**
 * Logout - invalidate session
 */
export async function logout(token: string): Promise<void> {
  memorySessions.delete(token);
  try {
    const session = await prisma.session.findUnique({
      where: { token },
    });

    if (session) {
      await prisma.session.delete({ where: { id: session.id } });
    }
  } catch {}
}

export { AppError } from '../errors/AppError';
