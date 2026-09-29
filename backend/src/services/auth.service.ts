import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { generateNonce, verifyWalletSignature } from '../utils/crypto';
import { generateToken, getSessionExpiry } from '../utils/jwt';
import TokenService from './token.service';
import { getTokenBySymbol } from '../utils/token-registry';
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

/**
 * Generate a nonce for wallet signature verification
 */
export async function createNonce(walletAddress: string): Promise<NonceResponse> {
  const nonce = generateNonce();
  const expiresAt = new Date(Date.now() + NONCE_EXPIRY_MINUTES * 60 * 1000);

  // Upsert - create or update nonce for this wallet
  await prisma.nonce.upsert({
    where: { walletAddress },
    update: { nonce, expiresAt },
    create: { walletAddress, nonce, expiresAt },
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

  // 1. Fetch nonce
  const nonceRecord = await prisma.nonce.findUnique({
    where: { walletAddress },
  });

  if (!nonceRecord) {
    throw new AppError('No nonce found. Please request a new nonce first.', 400);
  }

  // 2. Check nonce expiry
  if (new Date() > nonceRecord.expiresAt) {
    await prisma.nonce.delete({ where: { id: nonceRecord.id } });
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
  await prisma.nonce.delete({ where: { id: nonceRecord.id } });

  // 6. Find or create merchant
  let merchant = await prisma.merchant.findUnique({
    where: { walletAddress },
  });

  if (!merchant) {
    // Auto-create merchant on first wallet login
    merchant = await prisma.merchant.create({
      data: {
        walletAddress,
        email: `${walletAddress.slice(0, 8)}@wallet.fluxpay.io`,
        businessName: `Merchant ${walletAddress.slice(0, 6)}`,
      },
    });
  }

  // 7. Generate session
  const tokenPayload = {
    id: merchant.id,
    walletAddress: merchant.walletAddress,
    email: merchant.email,
    businessName: merchant.businessName,
  };

  const sessionToken = generateToken(tokenPayload);
  const expiresAt = getSessionExpiry();

  await prisma.session.create({
    data: {
      merchantId: merchant.id,
      token: sessionToken,
      expiresAt,
    },
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
      preferredTokenUpdatedAt: merchant.preferredTokenUpdatedAt?.toISOString(),
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
  const nonceRecord = await prisma.nonce.findUnique({
    where: { walletAddress },
  });

  if (!nonceRecord) {
    throw new AppError('No nonce found. Please request a new nonce first.', 400);
  }

  if (new Date() > nonceRecord.expiresAt) {
    await prisma.nonce.delete({ where: { id: nonceRecord.id } });
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
  await prisma.nonce.delete({ where: { id: nonceRecord.id } });

  // 5. Check if wallet already exists
  const existingWallet = await prisma.merchant.findUnique({
    where: { walletAddress },
  });
  if (existingWallet) {
    throw new AppError('A merchant with this wallet address already exists.', 409);
  }

  // 6. Check if email already exists (if provided)
  if (email && email.trim() !== '') {
    const existingEmail = await prisma.merchant.findFirst({
      where: { email },
    });
    if (existingEmail) {
      throw new AppError('A merchant with this email already exists.', 409);
    }
  }

  // 7. Create merchant with token preference
  const merchant = await prisma.merchant.create({
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

  // 9. Generate session
  const tokenPayload = {
    id: merchant.id,
    walletAddress: merchant.walletAddress,
    email: merchant.email,
    businessName: merchant.businessName,
  };

  const sessionToken = generateToken(tokenPayload);
  const expiresAt = getSessionExpiry();

  await prisma.session.create({
    data: {
      merchantId: merchant.id,
      token: sessionToken,
      expiresAt,
    },
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
      preferredTokenUpdatedAt: merchant.preferredTokenUpdatedAt?.toISOString(),
    },
  };
}



/**
 * Get current merchant info
 */
export async function getMe(merchantId: string): Promise<MeResponse> {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
  });

  if (!merchant) {
    throw new AppError('Merchant not found.', 404);
  }

  return {
    id: merchant.id,
    walletAddress: merchant.walletAddress,
    email: merchant.email,
    businessName: merchant.businessName,
    emailVerified: merchant.emailVerified,
    createdAt: merchant.createdAt.toISOString(),
    preferredTokenMint: merchant.preferredTokenMint || undefined,
    preferredTokenSymbol: merchant.preferredTokenSymbol || undefined,
    preferredTokenDecimals: merchant.preferredTokenDecimals || undefined,
    hasSelectedToken: merchant.hasSelectedToken,
    preferredTokenUpdatedAt: merchant.preferredTokenUpdatedAt?.toISOString(),
  };
}

/**
 * Update merchant profile
 */
export async function updateProfile(
  merchantId: string,
  data: { businessName?: string; email?: string }
): Promise<MeResponse> {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
  });

  if (!merchant) {
    throw new AppError('Merchant not found.', 404);
  }

  // If email is changing, check uniqueness using findFirst since it's not strictly unique
  if (data.email && data.email !== merchant.email) {
    const existing = await prisma.merchant.findFirst({ where: { email: data.email } });
    if (existing) {
      throw new AppError('Email already in use by another merchant.', 409);
    }
  }

  const updated = await prisma.merchant.update({
    where: { id: merchantId },
    data: {
      ...(data.businessName && { businessName: data.businessName }),
      ...(data.email && { email: data.email, emailVerified: false }),
    },
  });

  return {
    id: updated.id,
    walletAddress: updated.walletAddress,
    email: updated.email,
    businessName: updated.businessName,
    emailVerified: updated.emailVerified,
    createdAt: updated.createdAt.toISOString(),
  };
}

/**
 * Logout - invalidate session
 */
export async function logout(token: string): Promise<void> {
  const session = await prisma.session.findUnique({
    where: { token },
  });

  if (session) {
    await prisma.session.delete({ where: { id: session.id } });
  }
}

/**
 * Custom application error with status code
 */
export class AppError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'AppError';
  }
}
