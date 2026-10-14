/**
 * Checkout Session Service
 *
 * Manages the lifecycle of hosted checkout sessions:
 * create → awaiting_payment → payment_detected → swapping → completed
 *
 * This is the "Stripe Checkout" equivalent for Solana.
 */

import { PrismaClient, CheckoutSessionStatus } from '@prisma/client';
import { nanoid } from 'nanoid';
import { Keypair } from '@solana/web3.js';
import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger';
import { AppError, memoryMerchants } from './auth.service';
import { getJupiterQuote, buildJupiterSwapTransaction } from './jupiter.service';
import { deliverWebhook } from '../utils/webhook';
import { calculateSolBuffer } from '../utils/sol-buffer';
import { ensureTokenAccountExists } from '../utils/ensure-token-account';
import { EscrowService } from './escrow.service';
import { SettlementService } from './settlement.service';
import { getGasWalletKeypair, getEscrowWalletPublicKey } from '../config/wallets';
import { generateNonce, verifyWalletSignature } from '../utils/crypto';
import { getJwtSecret } from '../utils/jwt';

const prisma = new PrismaClient();

// In-memory checkout sessions map for dev mode / DB resilience
export const memoryCheckoutSessions = new Map<string, any>();

// In-memory checkout nonces map for customer wallet verification
export interface CheckoutNonce {
  sessionId: string;
  customerWallet: string;
  nonce: string;
  message: string;
  expiresAt: Date;
}
export const memoryCheckoutNonces = new Map<string, CheckoutNonce>();

const SESSION_EXPIRY_HOURS = 1;
const CHECKOUT_BASE_URL = process.env.FLUXPAY_CHECKOUT_URL || process.env.FRONTEND_URL || 'http://localhost:3000';
const JUPITER_QUOTE_URL = process.env.JUPITER_API_URL ? `${process.env.JUPITER_API_URL}/quote` : 'https://api.jup.ag/swap/v1/quote';

// Token info for resolving session token symbols to mint addresses
const TOKEN_INFO: Record<string, { mint: string; decimals: number }> = {
  SOL:  { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  USDT: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
  BONK: { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
  JUP:  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6 },
  PYTH: { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', decimals: 6 },
  WIF:  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', decimals: 6 },
  JTO:  { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', decimals: 9 },
  RAY:  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals: 6 },
  ORCA: { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', decimals: 6 },
};

// ─── Interfaces ─────────────────────────────────────────────

interface CreateCheckoutSessionInput {
  merchantId: string;
  amount: number;
  token: string;
  orderId?: string;
  successUrl?: string;
  cancelUrl?: string;
  webhookUrl?: string;
  metadata?: Record<string, any>;
}

// ─── Create Checkout Session ────────────────────────────────

export async function createCheckoutSession(input: CreateCheckoutSessionInput) {
  const { merchantId, amount, token, orderId, successUrl, cancelUrl, webhookUrl } = input;

  if (amount <= 0) {
    throw new AppError('Amount must be greater than 0', 400);
  }

  // Verify merchant exists
  let merchant: any = null;
  try {
    merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: {
        id: true,
        businessName: true,
        walletAddress: true,
        preferredTokenSymbol: true,
        preferredTokenMint: true,
        preferredTokenDecimals: true,
        webhookUrl: true,
      },
    });
  } catch (err: any) {
    logger.warn(`[Checkout] DB merchant lookup failed: ${err.message}`);
  }

  if (!merchant) {
    const mem = memoryMerchants.get(merchantId);
    merchant = {
      id: merchantId,
      businessName: mem?.businessName || 'FluxPay Merchant',
      walletAddress: mem?.walletAddress || '7J5tPd33wXDFVcFvgPJdhiTrG3qxvJbCp1JiQZET3NFh',
      preferredTokenSymbol: mem?.preferredTokenSymbol || 'USDC',
      preferredTokenMint: mem?.preferredTokenMint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      preferredTokenDecimals: mem?.preferredTokenDecimals || 6,
      webhookUrl: mem?.webhookUrl || null,
    };
  }

  // Idempotency: prevent duplicate sessions for same orderId
  if (orderId) {
    try {
      const existing = await prisma.checkoutSession.findFirst({
        where: {
          merchantId,
          orderId,
          status: { in: ['PENDING', 'SWAPPING'] },
          expiresAt: { gt: new Date() },
        },
      });

      if (existing) {
        logger.info(`Returning existing active session: ${existing.id} for orderId: ${orderId}`);
        return {
          id: existing.id,
          sessionId: existing.id,
          checkoutUrl: `${CHECKOUT_BASE_URL}/pay/${existing.id}`,
          amount: existing.amount,
          token: existing.token,
          status: existing.status,
          expiresAt: existing.expiresAt.toISOString(),
        };
      }
    } catch {}
  }

  const sessionId = nanoid(24);
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_HOURS * 60 * 60 * 1000);

  let session: any = null;
  try {
    session = await prisma.checkoutSession.create({
      data: {
        id: sessionId,
        merchantId,
        orderId: orderId || null,
        amount,
        token: token.toUpperCase(),
        successUrl: successUrl || null,
        cancelUrl: cancelUrl || null,
        webhookUrl: webhookUrl || merchant.webhookUrl || null,
        status: 'PENDING',
        expiresAt,
      },
    });
  } catch (err: any) {
    logger.warn(`[Checkout] DB create session failed, using memory fallback: ${err.message}`);
    session = {
      id: sessionId,
      merchantId,
      merchant,
      orderId: orderId || null,
      amount,
      token: token.toUpperCase(),
      successUrl: successUrl || null,
      cancelUrl: cancelUrl || null,
      webhookUrl: webhookUrl || merchant.webhookUrl || null,
      status: 'PENDING',
      expiresAt,
      createdAt: new Date(),
    };
    memoryCheckoutSessions.set(sessionId, session);
  }

  return {
    id: session.id,
    sessionId: session.id,
    checkoutUrl: `${CHECKOUT_BASE_URL}/pay/${session.id}`,
    amount: session.amount,
    token: session.token,
    status: session.status,
    expiresAt: session.expiresAt instanceof Date ? session.expiresAt.toISOString() : session.expiresAt,
  };
}

// ─── Get Checkout Session (Public — no auth needed) ─────────

export async function getCheckoutSession(sessionId: string) {
  let session: any = null;
  try {
    session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      include: {
        merchant: {
          select: {
            businessName: true,
            walletAddress: true,
            preferredTokenSymbol: true,
            preferredTokenMint: true,
            preferredTokenDecimals: true,
          },
        },
      },
    });
  } catch (err: any) {
    logger.warn(`[Checkout] DB getSession failed: ${err.message}`);
  }

  if (!session) {
    session = memoryCheckoutSessions.get(sessionId);
    if (!session) {
      if (typeof sessionId === 'string' && sessionId.startsWith('sess_demo_')) {
        const memM = memoryMerchants.get('merchant_live') || {
          businessName: 'SHOEPLACE.NG',
          walletAddress: '7J5tPd33wXDFVcFvgPJdhiTrG3qxvJbCp1JiQZET3NFh',
          preferredTokenSymbol: 'USDC',
          preferredTokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          preferredTokenDecimals: 6,
        };
        session = {
          id: sessionId,
          merchantId: 'merchant_live',
          merchant: memM,
          orderId: null,
          amount: 1.5,
          token: 'USDC',
          status: 'PENDING',
          customerWallet: null,
          expiresAt: new Date(Date.now() + 3600000),
          createdAt: new Date(),
        };
        memoryCheckoutSessions.set(sessionId, session);
      } else {
        throw new AppError('Checkout session not found', 404);
      }
    }
  }

  // Check expiry
  if (session.status === 'PENDING' && new Date() > new Date(session.expiresAt)) {
    try {
      await prisma.checkoutSession.update({
        where: { id: sessionId },
        data: { status: 'EXPIRED' },
      });
    } catch {}
    session.status = 'EXPIRED';
    throw new AppError('Checkout session has expired', 410);
  }

  const merchantObj = session.merchant || {
    businessName: 'FluxPay Merchant',
    walletAddress: '7J5tPd33wXDFVcFvgPJdhiTrG3qxvJbCp1JiQZET3NFh',
    preferredTokenSymbol: 'USDC',
    preferredTokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    preferredTokenDecimals: 6,
  };

  // Resolve the session token to a mint address
  const sessionTokenInfo = TOKEN_INFO[session.token.toUpperCase()];
  const merchantTokenMint = sessionTokenInfo?.mint || merchantObj.preferredTokenMint;
  const merchantTokenDecimals = sessionTokenInfo?.decimals ?? merchantObj.preferredTokenDecimals;

  // Calculate SOL buffer for fee reservation
  let solBufferInfo = null;
  try {
    const buffer = await calculateSolBuffer();
    solBufferInfo = {
      totalBufferSol: buffer.totalBufferSol,
      rentExemptionSol: buffer.rentExemptionSol,
      networkFeeSol: buffer.networkFeeSol,
      priorityFeeSol: buffer.priorityFeeSol,
    };
  } catch (err) {
    logger.warn('[Checkout] Failed to calculate SOL buffer:', err);
  }

  const mem = memoryCheckoutSessions.get(session.id);
  const isVerified = !!(mem?.customerVerified || (session.customerWallet && mem?.customerWallet === session.customerWallet));

  return {
    id: session.id,
    merchantName: merchantObj.businessName,
    merchantWallet: merchantObj.walletAddress,
    merchantPreferredToken: merchantObj.preferredTokenSymbol,
    merchantTokenMint,
    merchantTokenDecimals,
    orderId: session.orderId,
    amount: session.amount,
    token: session.token,
    status: session.status,
    customerWallet: session.customerWallet || mem?.customerWallet || null,
    customerVerified: isVerified,
    transactionHash: session.transactionHash,
    successUrl: session.successUrl,
    cancelUrl: session.cancelUrl,
    errorMessage: session.errorMessage,
    solBuffer: solBufferInfo,
    expiresAt: session.expiresAt instanceof Date ? session.expiresAt.toISOString() : session.expiresAt,
    createdAt: session.createdAt instanceof Date ? session.createdAt.toISOString() : (session.createdAt || new Date().toISOString()),
  };
}

// ─── Get Checkout Session Status (lightweight polling) ──────

export async function getCheckoutSessionStatus(sessionId: string) {
  let session: any = null;
  try {
    session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        status: true,
        transactionHash: true,
        customerWallet: true,
        errorMessage: true,
        successUrl: true,
      },
    });
  } catch (err: any) {
    logger.warn(`[Checkout] DB getCheckoutSessionStatus failed: ${err.message}`);
  }

  if (!session) {
    session = memoryCheckoutSessions.get(sessionId);
    if (!session) {
      if (typeof sessionId === 'string' && sessionId.startsWith('sess_demo_')) {
        session = {
          id: sessionId,
          status: 'PENDING',
          transactionHash: null,
          customerWallet: null,
          errorMessage: null,
          successUrl: null,
        };
        memoryCheckoutSessions.set(sessionId, session);
      } else {
        throw new AppError('Checkout session not found', 404);
      }
    }
  }

  const mem = memoryCheckoutSessions.get(sessionId);
  const isVerified = !!(mem?.customerVerified || (session.customerWallet && mem?.customerWallet === session.customerWallet));

  return {
    id: session.id,
    status: session.status,
    transactionHash: session.transactionHash,
    customerWallet: session.customerWallet || mem?.customerWallet || null,
    customerVerified: isVerified,
    errorMessage: session.errorMessage,
    successUrl: session.successUrl,
  };
}

// ─── Create Checkout Nonce (Step 3: Verification Challenge) ───

export async function createCheckoutNonce(sessionId: string, customerWallet: string) {
  let session: any = null;
  try {
    session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
    });
  } catch (err: any) {
    logger.warn(`[Checkout] DB lookup for nonce failed: ${err.message}`);
  }

  if (!session) {
    session = memoryCheckoutSessions.get(sessionId);
  }

  if (!session) {
    if (typeof sessionId === 'string' && sessionId.startsWith('sess_demo_')) {
      session = {
        id: sessionId,
        merchantId: 'merchant_live',
        amount: 1.5,
        token: 'USDC',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 3600000),
      };
      memoryCheckoutSessions.set(sessionId, session);
    } else {
      throw new AppError('Checkout session not found', 404);
    }
  }

  if (session.status !== 'PENDING' && session.status !== 'AWAITING_PAYMENT') {
    throw new AppError(`Checkout session is ${session.status} and cannot be authenticated`, 400);
  }

  if (new Date() > new Date(session.expiresAt)) {
    throw new AppError('Checkout session has expired', 410);
  }

  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes TTL
  const nonce = generateNonce();
  const message = `Sign this message to authenticate your wallet for checkout session ${sessionId}: ${nonce}`;

  const key = `${sessionId}:${customerWallet}`;
  memoryCheckoutNonces.set(key, {
    sessionId,
    customerWallet,
    nonce,
    message,
    expiresAt,
  });

  return {
    sessionId,
    customerWallet,
    nonce,
    message,
    expiresAt: expiresAt.toISOString(),
  };
}

// ─── Verify Checkout Signature (Step 3: Cryptographic Proof) ───

export async function verifyCheckoutSignature(
  sessionId: string,
  customerWallet: string,
  message: string,
  signature: string
) {
  let session: any = null;
  try {
    session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
    });
  } catch (err: any) {
    logger.warn(`[Checkout] DB lookup for verify failed: ${err.message}`);
  }

  if (!session) {
    session = memoryCheckoutSessions.get(sessionId);
  }

  if (!session) {
    throw new AppError('Checkout session not found', 404);
  }

  if (session.status !== 'PENDING' && session.status !== 'AWAITING_PAYMENT') {
    throw new AppError(`Checkout session is ${session.status} and cannot be authenticated`, 400);
  }

  if (new Date() > new Date(session.expiresAt)) {
    throw new AppError('Checkout session has expired', 410);
  }

  const key = `${sessionId}:${customerWallet}`;
  const nonceRecord = memoryCheckoutNonces.get(key);

  if (!nonceRecord) {
    throw new AppError('No active verification challenge found. Please request a new nonce.', 400);
  }

  if (new Date() > nonceRecord.expiresAt) {
    memoryCheckoutNonces.delete(key);
    throw new AppError('Verification challenge has expired. Please sign again.', 400);
  }

  if (message !== nonceRecord.message) {
    throw new AppError('Invalid verification message format.', 400);
  }

  // Cryptographically verify ed25519 signature
  const isValid = verifyWalletSignature(message, signature, customerWallet);
  if (!isValid) {
    throw new AppError('Invalid wallet signature. Ownership proof failed.', 401);
  }

  // Single-use: delete nonce immediately
  memoryCheckoutNonces.delete(key);

  // Issue customer checkout token
  const customerToken = jwt.sign(
    {
      sessionId,
      customerWallet,
      role: 'customer',
    },
    getJwtSecret(),
    { expiresIn: '1h' }
  );

  // Persist verified customer wallet
  try {
    await prisma.checkoutSession.update({
      where: { id: sessionId },
      data: { customerWallet },
    });
  } catch (err: any) {
    logger.warn(`[Checkout] DB update customerWallet failed, using memory: ${err.message}`);
  }

  // Update in-memory session
  const mem = memoryCheckoutSessions.get(sessionId) || { ...session };
  mem.customerWallet = customerWallet;
  mem.customerVerified = true;
  mem.customerVerifiedAt = new Date();
  mem.customerSignature = signature;
  mem.customerToken = customerToken;
  memoryCheckoutSessions.set(sessionId, mem);

  return {
    success: true,
    verified: true,
    sessionId,
    customerWallet,
    customerToken,
    message: 'Customer wallet authenticated successfully',
  };
}

// ─── Execute Payment (after customer connects wallet & signs) ───────

export async function executeCheckoutPayment(
  sessionId: string,
  customerWallet: string,
  inputToken: string,
  inputAmount: number,
  customerToken?: string
) {
  // 1. Verify customer authentication (wallet connect + signature proof)
  const memSession = memoryCheckoutSessions.get(sessionId);
  let isVerified = !!(memSession && memSession.customerVerified && memSession.customerWallet === customerWallet);

  if (!isVerified && customerToken) {
    try {
      const decoded = jwt.verify(customerToken, getJwtSecret()) as any;
      if (decoded && decoded.sessionId === sessionId && decoded.customerWallet === customerWallet) {
        isVerified = true;
      }
    } catch {}
  }

  let session: any = null;
  try {
    session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      include: {
        merchant: {
          select: {
            walletAddress: true,
            preferredTokenSymbol: true,
            preferredTokenMint: true,
            preferredTokenDecimals: true,
            settlementType: true,
          },
        },
      },
    });
  } catch (err: any) {
    logger.warn(`[Checkout] DB find checkoutSession failed, fallback to memory: ${err.message}`);
  }

  if (!session) {
    session = memSession;
  }

  if (!session) {
    throw new AppError('Checkout session not found', 404);
  }

  if (!isVerified && session.customerWallet === customerWallet && memSession?.customerVerified) {
    isVerified = true;
  }

  if (!isVerified) {
    throw new AppError('Customer wallet authentication required. Please connect your wallet and sign the verification message first.', 401);
  }

  if (!session.merchant) {
    session.merchant = {
      walletAddress: session.merchantWallet || '7J5tPd33wXDFVcFvgPJdhiTrG3qxvJbCp1JiQZET3NFh',
      preferredTokenSymbol: session.preferredTokenSymbol || 'USDC',
      preferredTokenMint: session.preferredTokenMint || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      preferredTokenDecimals: session.preferredTokenDecimals || 6,
      settlementType: 'INSTANT_SETTLEMENT',
    };
  }

  if (session.status !== 'PENDING' && session.status !== 'AWAITING_PAYMENT') {
    throw new AppError(`Session is in ${session.status} state and cannot be executed`, 400);
  }

  if (new Date() > session.expiresAt) {
    await prisma.checkoutSession.update({
      where: { id: sessionId },
      data: { status: 'EXPIRED' },
    });
    throw new AppError('Checkout session has expired', 410);
  }

  // Resolve the merchant's output token mint and decimals
  const sessionTokenInfo = TOKEN_INFO[session.token.toUpperCase()];
  const merchantTokenMint = sessionTokenInfo?.mint || session.merchant.preferredTokenMint;
  const merchantTokenDecimals = sessionTokenInfo?.decimals ?? session.merchant.preferredTokenDecimals;
  const merchantWallet = session.merchant.walletAddress;

  // Compare MINT ADDRESSES (not symbols) to detect if swap is needed
  const swapNeeded = inputToken !== merchantTokenMint;

  if (swapNeeded) {
    // Calculate output amount in smallest units for ExactOut quote
    const outputAmountSmallest = Math.floor(session.amount * Math.pow(10, merchantTokenDecimals));

    // Get ExactOut quote directly from Jupiter — "I need exactly X output, how much input?"
    const quoteParams = new URLSearchParams({
      inputMint: inputToken,
      outputMint: merchantTokenMint,
      amount: String(outputAmountSmallest),
      slippageBps: '50',
      swapMode: 'ExactOut',
      excludeDexes: 'Pump.fun Amm',
    });

    logger.info(`[Checkout] Getting ExactOut quote: ${outputAmountSmallest} smallest units of ${session.token}`, {
      inputMint: inputToken,
      outputMint: merchantTokenMint,
    });

    console.log('Jupiter quote request:', { inputMint: inputToken, outputMint: merchantTokenMint, amount: outputAmountSmallest, swapMode: 'ExactOut' });

    const quoteHeaders: Record<string, string> = {
      'Accept': 'application/json',
    };
    if (process.env.JUPITER_API_KEY) {
      quoteHeaders['x-api-key'] = process.env.JUPITER_API_KEY;
    }

    const quoteRes = await fetch(`${JUPITER_QUOTE_URL}?${quoteParams}`, {
      headers: quoteHeaders,
      signal: AbortSignal.timeout(15000),
    });

    if (!quoteRes.ok) {
      const errBody = await quoteRes.text().catch(() => '');
      logger.error('[Checkout] Jupiter quote failed:', errBody);
      throw new AppError('Failed to get swap quote from Jupiter', 422);
    }

    const quote = (await quoteRes.json()) as any;

    if (!quote || quote.error || !quote.inAmount) {
      logger.error('[Checkout] Jupiter returned invalid quote:', quote);
      throw new AppError('No swap route found for this token pair', 422);
    }

    // ─── Fix 2: Pre-create merchant ATA before swap ─────────
    // Jupiter error 6024 occurs when the merchant wallet has never
    // held the output token. FluxPay sponsors the ~0.002 SOL rent.
    try {
      try {
        const gasKeypair = getGasWalletKeypair();

        // Ensure merchant has ATA for the output token they will receive
        const merchantATAResult = await ensureTokenAccountExists(
          merchantWallet,
          merchantTokenMint,
          gasKeypair
        );
        if (merchantATAResult.created) {
          logger.info(`[Checkout] Created merchant ATA for ${session.token} (tx: ${merchantATAResult.txSignature})`);
        }

        // Ensure customer has ATA for the output token (Jupiter may need it for intermediate routing)
        const customerATAResult = await ensureTokenAccountExists(
          customerWallet,
          merchantTokenMint,
          gasKeypair
        );
        if (customerATAResult.created) {
          logger.info(`[Checkout] Created customer ATA for ${session.token} (tx: ${customerATAResult.txSignature})`);
        }
      } catch (keyErr: any) {
        logger.warn(`[Checkout] Could not load gas wallet for ATA creation: ${keyErr.message}`);
      }
    } catch (ataErr: any) {
      // Non-fatal: Jupiter may still handle ATA creation via useSharedAccounts
      logger.warn(`[Checkout] ATA pre-creation failed (non-fatal): ${ataErr.message}`);
    }

    // Determine destination token account:
    // For FIAT merchants -> output to Escrow Wallet
    // For CRYPTO merchants -> output directly to merchant wallet
    const destinationTokenAccount =
      session.merchant.settlementType === 'FIAT'
        ? getEscrowWalletPublicKey().toBase58()
        : merchantWallet;

    // Build swap transaction
    const { transaction, lastValidBlockHeight } = await buildJupiterSwapTransaction({
      quote,
      userPublicKey: customerWallet,
      destinationTokenAccount,
    });

    // Lock session
    await prisma.checkoutSession.update({
      where: { id: sessionId },
      data: {
        status: 'SWAPPING',
        customerWallet,
        inputToken,
        swapQuote: quote as any,
      },
    });

    return {
      sessionId,
      transaction: Buffer.from(transaction.serialize()).toString('base64'),
      lastValidBlockHeight,
      expectedOutput: quote.outAmount,
      merchantWallet,
      swapRequired: true,
    };
  }

  // No swap needed — direct transfer
  await prisma.checkoutSession.update({
    where: { id: sessionId },
    data: {
      customerWallet,
      inputToken,
      status: 'AWAITING_PAYMENT',
    },
  });

  return {
    sessionId,
    transaction: null,
    expectedOutput: session.amount,
    merchantWallet,
    swapRequired: false,
    directTransfer: {
      to: merchantWallet,
      amount: session.amount,
      token: inputToken,
    },
  };
}

// ─── Confirm Payment (after tx is confirmed on-chain) ───────

export async function confirmCheckoutPayment(sessionId: string, txHash: string) {
  const memSession = memoryCheckoutSessions.get(sessionId);
  let session: any = null;
  try {
    session = await prisma.checkoutSession.findUnique({
      where: { id: sessionId },
      include: {
        merchant: {
          select: {
            id: true,
            businessName: true,
            walletAddress: true,
          },
        },
      },
    });
  } catch (err: any) {
    logger.warn(`[Checkout] DB lookup for confirm failed: ${err.message}`);
  }

  if (!session) {
    session = memSession;
  }

  if (!session) {
    throw new AppError('Checkout session not found', 404);
  }

  if (!session.customerWallet && (!memSession || !memSession.customerVerified)) {
    throw new AppError('Customer wallet authentication required. Session has not been verified.', 401);
  }

  if (session.status === 'COMPLETED') {
    return { status: 'COMPLETED', transactionHash: session.transactionHash };
  }

  // Mark in-memory session completed
  session.status = 'COMPLETED';
  session.transactionHash = txHash;
  if (memSession) {
    memSession.status = 'COMPLETED';
    memSession.transactionHash = txHash;
  }

  let payment: any = { id: `pay_${Date.now()}` };

  try {
    // Update session to completed
    await prisma.checkoutSession.update({
      where: { id: sessionId },
      data: {
        status: 'COMPLETED',
        transactionHash: txHash,
      },
    });

    const merchantWallet = session.merchant?.walletAddress || memSession?.merchant?.walletAddress || '6pM45y8uuKyZBs92HM9npp5MufzzJoPQvKbUXwWGE5sL';

    // Also create a Payment record for the merchant's dashboard
    payment = await prisma.payment.create({
      data: {
        merchant: { connect: { id: session.merchantId } },
        amount: session.amount,
        token: session.token,
        customerWallet: session.customerWallet,
        status: 'COMPLETED',
        txHash,
        merchantWallet,
        expiresAt: session.expiresAt,
        completedAt: new Date(),
        metadata: { checkoutSessionId: session.id, orderId: session.orderId },
      },
    });

    // Increment escrow balance for FIAT settlement merchants
    await EscrowService.incrementMerchantEscrow(session.merchantId, session.amount).catch(() => {});

    // Auto-fiat conversion & payout: If merchant is configured for FIAT settlement
    try {
      const merchantSettings = await SettlementService.findMerchant(session.merchantId);
      if (merchantSettings?.settlementType === 'FIAT' && merchantSettings.defaultPayoutAccountId) {
        logger.info(`[Checkout] Merchant ${session.merchantId} configured for FIAT settlement. Auto-triggering fiat conversion & payout to bank...`);
        await SettlementService.triggerSettlement(session.merchantId);
      }
    } catch (settleErr: any) {
      logger.warn(`[Checkout] Automatic fiat settlement trigger deferred: ${settleErr.message}`);
    }

    // Link payment to session
    await prisma.checkoutSession.update({
      where: { id: sessionId },
      data: { paymentId: payment.id },
    }).catch(() => {});

    // Create payment event
    await prisma.paymentEvent.create({
      data: { paymentId: payment.id, status: 'COMPLETED' },
    }).catch(() => {});
  } catch (dbErr: any) {
    logger.warn(`[Checkout] DB write skipped in confirmCheckoutPayment: ${dbErr.message}`);
  }

  // Deliver webhook to merchant
  const webhookPayload = {
    event: 'checkout.session.completed',
    sessionId: session.id,
    orderId: session.orderId,
    amount: session.amount,
    token: session.token,
    customerWallet: session.customerWallet,
    transactionHash: txHash,
    merchantId: session.merchantId,
  };

  const webhookUrl = session.webhookUrl || 'http://localhost:3002/api/webhooks/fluxpay';
  const webhookSecret = process.env.FLUXPAY_WEBHOOK_SECRET || 'whsec_0f9c0a8271e4792feeade69df3f51c221f4eb9fa05658050';

  // Deliver both events for maximum compatibility
  deliverWebhook({
    merchantId: session.merchantId,
    webhookUrl,
    webhookSecret,
    event: 'checkout.session.completed',
    data: webhookPayload,
  }).catch((err) => logger.error('[Checkout] Webhook delivery error:', err));

  deliverWebhook({
    merchantId: session.merchantId,
    webhookUrl,
    webhookSecret,
    event: 'payment.completed',
    data: webhookPayload,
  }).catch((err) => logger.error('[Checkout] Webhook delivery error (payment.completed):', err));

  return {
    status: 'COMPLETED',
    transactionHash: txHash,
    paymentId: payment.id,
  };
}

// ─── Expire Stale Checkout Sessions ─────────────────────────

export async function expireCheckoutSessions(): Promise<number> {
  const result = await prisma.checkoutSession.updateMany({
    where: {
      status: { in: ['PENDING', 'AWAITING_PAYMENT'] },
      expiresAt: { lt: new Date() },
    },
    data: { status: 'EXPIRED' },
  });

  return result.count;
}
