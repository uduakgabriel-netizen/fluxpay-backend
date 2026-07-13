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
import { logger } from '../utils/logger';
import { AppError } from './auth.service';
import { getJupiterQuote, buildJupiterSwapTransaction } from './jupiter.service';
import { deliverWebhook } from '../utils/webhook';
import { calculateSolBuffer } from '../utils/sol-buffer';
import { ensureTokenAccountExists } from '../utils/ensure-token-account';

const prisma = new PrismaClient();

const SESSION_EXPIRY_HOURS = 1;
const CHECKOUT_BASE_URL = process.env.FLUXPAY_CHECKOUT_URL || process.env.FRONTEND_URL || 'http://localhost:3000';
const JUPITER_QUOTE_URL = process.env.JUPITER_API_URL ? `${process.env.JUPITER_API_URL}/quote` : 'https://api.jup.ag/swap/v2/quote';

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
  const merchant = await prisma.merchant.findUnique({
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

  if (!merchant) {
    throw new AppError('Merchant not found', 404);
  }

  // Idempotency: prevent duplicate sessions for same orderId
  if (orderId) {
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
        checkoutUrl: `${CHECKOUT_BASE_URL}/pay/${existing.id}`,
        amount: existing.amount,
        token: existing.token,
        status: existing.status,
        expiresAt: existing.expiresAt.toISOString(),
      };
    }
  }

  const sessionId = nanoid(24);
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_HOURS * 60 * 60 * 1000);

  const session = await prisma.checkoutSession.create({
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

  return {
    id: session.id,
    checkoutUrl: `${CHECKOUT_BASE_URL}/pay/${session.id}`,
    amount: session.amount,
    token: session.token,
    status: session.status,
    expiresAt: session.expiresAt.toISOString(),
  };
}

// ─── Get Checkout Session (Public — no auth needed) ─────────

export async function getCheckoutSession(sessionId: string) {
  const session = await prisma.checkoutSession.findUnique({
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

  if (!session) {
    throw new AppError('Checkout session not found', 404);
  }

  // Check expiry
  if (session.status === 'PENDING' && new Date() > session.expiresAt) {
    await prisma.checkoutSession.update({
      where: { id: sessionId },
      data: { status: 'EXPIRED' },
    });
    throw new AppError('Checkout session has expired', 410);
  }

  // Resolve the session token to a mint address
  const sessionTokenInfo = TOKEN_INFO[session.token.toUpperCase()];
  const merchantTokenMint = sessionTokenInfo?.mint || session.merchant.preferredTokenMint;
  const merchantTokenDecimals = sessionTokenInfo?.decimals ?? session.merchant.preferredTokenDecimals;

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

  return {
    id: session.id,
    merchantName: session.merchant.businessName,
    merchantWallet: session.merchant.walletAddress,
    merchantPreferredToken: session.merchant.preferredTokenSymbol,
    merchantTokenMint,
    merchantTokenDecimals,
    orderId: session.orderId,
    amount: session.amount,
    token: session.token,
    status: session.status,
    customerWallet: session.customerWallet,
    transactionHash: session.transactionHash,
    successUrl: session.successUrl,
    cancelUrl: session.cancelUrl,
    errorMessage: session.errorMessage,
    solBuffer: solBufferInfo,
    expiresAt: session.expiresAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
  };
}

// ─── Get Checkout Session Status (lightweight polling) ──────

export async function getCheckoutSessionStatus(sessionId: string) {
  const session = await prisma.checkoutSession.findUnique({
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

  if (!session) {
    throw new AppError('Checkout session not found', 404);
  }

  return {
    id: session.id,
    status: session.status,
    transactionHash: session.transactionHash,
    customerWallet: session.customerWallet,
    errorMessage: session.errorMessage,
    successUrl: session.successUrl,
  };
}

// ─── Execute Payment (after customer connects wallet) ───────

export async function executeCheckoutPayment(sessionId: string, customerWallet: string, inputToken: string, inputAmount: number) {
  const session = await prisma.checkoutSession.findUnique({
    where: { id: sessionId },
    include: {
      merchant: {
        select: {
          walletAddress: true,
          preferredTokenSymbol: true,
          preferredTokenMint: true,
          preferredTokenDecimals: true,
        },
      },
    },
  });

  if (!session) {
    throw new AppError('Checkout session not found', 404);
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

    const quoteRes = await fetch(`${JUPITER_QUOTE_URL}?${quoteParams}`, {
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
      const gasWalletKey = process.env.FLUXPAY_WALLET_PRIVATE_KEY;
      if (gasWalletKey) {
        let gasKeypair: Keypair;
        try {
          if (gasWalletKey.startsWith('[')) {
            gasKeypair = Keypair.fromSecretKey(new Uint8Array(JSON.parse(gasWalletKey)));
          } else if (gasWalletKey.length > 100) {
            gasKeypair = Keypair.fromSecretKey(new Uint8Array(Buffer.from(gasWalletKey, 'base64')));
          } else {
            gasKeypair = Keypair.fromSecretKey(new Uint8Array(Buffer.from(gasWalletKey, 'hex')));
          }

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
      }
    } catch (ataErr: any) {
      // Non-fatal: Jupiter may still handle ATA creation via useSharedAccounts
      logger.warn(`[Checkout] ATA pre-creation failed (non-fatal): ${ataErr.message}`);
    }

    // Build swap transaction
    const { transaction, lastValidBlockHeight } = await buildJupiterSwapTransaction({
      quote,
      userPublicKey: customerWallet,
      destinationTokenAccount: merchantWallet,
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
  const session = await prisma.checkoutSession.findUnique({
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

  if (!session) {
    throw new AppError('Checkout session not found', 404);
  }

  if (session.status === 'COMPLETED') {
    return { status: 'COMPLETED', transactionHash: session.transactionHash };
  }

  // Update session to completed
  await prisma.checkoutSession.update({
    where: { id: sessionId },
    data: {
      status: 'COMPLETED',
      transactionHash: txHash,
    },
  });

  // Also create a Payment record for the merchant's dashboard
  const payment = await prisma.payment.create({
    data: {
      merchant: { connect: { id: session.merchantId } },
      amount: session.amount,
      token: session.token,
      customerWallet: session.customerWallet,
      status: 'COMPLETED',
      txHash,
      merchantWallet: session.merchant.walletAddress,
      expiresAt: session.expiresAt,
      completedAt: new Date(),
      metadata: { checkoutSessionId: session.id, orderId: session.orderId },
    },
  });

  // Link payment to session
  await prisma.checkoutSession.update({
    where: { id: sessionId },
    data: { paymentId: payment.id },
  });

  // Create payment event
  await prisma.paymentEvent.create({
    data: { paymentId: payment.id, status: 'COMPLETED' },
  });

  // Deliver webhook to merchant
  const webhookPayload = {
    event: 'payment.completed',
    sessionId: session.id,
    orderId: session.orderId,
    amount: session.amount,
    token: session.token,
    customerWallet: session.customerWallet,
    transactionHash: txHash,
    merchantId: session.merchantId,
  };

  // Use merchant's session-level webhookUrl or fall back to configured webhook
  deliverWebhook({
    merchantId: session.merchantId,
    event: 'payment.completed',
    data: webhookPayload,
  }).catch((err) => logger.error('[Checkout] Webhook delivery error:', err));

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
