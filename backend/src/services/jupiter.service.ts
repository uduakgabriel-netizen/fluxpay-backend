import { logger } from '../utils/logger';
/**
 * Jupiter Swap Service — PRODUCTION (Non-Custodial)
 *
 * Real integration with Jupiter DEX Aggregator v6 for token swaps on Solana.
 *
 * NON-CUSTODIAL FLOW:
 * 1. GET /quote — Get best swap route and price
 * 2. POST /swap — Get the serialized swap transaction with:
 *    - userPublicKey: customerWallet (customer pays from here)
 *    - destinationTokenAccount: merchantWallet (merchant receives here)
 *    - useSharedAccounts: true (auto-create ATA if missing)
 * 3. Customer signs the transaction on frontend
 * 4. FluxPay co-signs (for gas) and submits to Solana
 *
 * FluxPay NEVER holds customer funds.
 */

import {
  Keypair,
  VersionedTransaction,
  PublicKey,
} from '@solana/web3.js';
import { PrismaClient, PaymentStatus } from '@prisma/client';
import { getMintAddress, getTokenBySymbol } from '../utils/token-registry';
import { getConnection, getRecommendedPriorityFee, withFailover } from '../config/solana';
import { AlertService } from './alert.service';

const prisma = new PrismaClient();

const JUPITER_API_URL = process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v2';
const MAX_SWAP_RETRIES = 5;
const QUOTE_EXPIRY_SECONDS = 60;
const INITIAL_SLIPPAGE_BPS = 100; // 1%
const MAX_SLIPPAGE_BPS = 1000; // 10%

// Retry delays: 5s, 5s, 10s, 15s (between attempts)
const RETRY_DELAYS_MS = [5000, 5000, 10000, 15000];

// ─── Interfaces ─────────────────────────────────────────────

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: any[];
  estimatedFeeInSol: number;
}

export interface SwapResult {
  success: boolean;
  txHash?: string;
  inputAmount: number;
  outputAmount: number;
  fee: number;
  error?: string;
}

// ─── Get Swap Quote (ExactOut) ───────────────────────────────

/**
 * Get the best swap quote from Jupiter API using ExactOut mode.
 *
 * For a payment gateway, the merchant specifies the exact output amount they
 * want to receive. Jupiter calculates how much input the buyer must send.
 *
 * @param fromToken - Token symbol to swap from (e.g., "BONK") — the buyer's token
 * @param toToken - Token symbol to swap to (e.g., "USDC") — the merchant's token
 * @param amount - Exact amount the merchant wants to RECEIVE (human-readable output)
 * @param slippageBps - Slippage tolerance in basis points
 * @returns Swap quote with calculated input amount and route, or null on failure
 */
export async function getSwapQuote(
  fromToken: string,
  toToken: string,
  amount: number,
  slippageBps: number = INITIAL_SLIPPAGE_BPS
): Promise<SwapQuote | null> {
  const inputMint = getMintAddress(fromToken);
  const outputMint = getMintAddress(toToken);

  if (!inputMint || !outputMint) {
    logger.error(`[Jupiter] Unknown token: ${fromToken} or ${toToken}`);
    return null;
  }

  // ExactOut: amount is the desired OUTPUT, so use the OUTPUT token's decimals
  const toTokenInfo = getTokenBySymbol(toToken);
  if (!toTokenInfo) {
    logger.error(`[Jupiter] Unknown output token: ${toToken}`);
    return null;
  }

  // Convert human-readable output amount to smallest unit (e.g., 200 USDC → 200000000)
  const outputAmountSmallest = Math.floor(amount * Math.pow(10, toTokenInfo.decimals));

  try {
    const url = new URL(`${JUPITER_API_URL}/quote`);
    url.searchParams.set('inputMint', inputMint);
    url.searchParams.set('outputMint', outputMint);
    url.searchParams.set('amount', outputAmountSmallest.toString());
    url.searchParams.set('slippageBps', slippageBps.toString());
    url.searchParams.set('swapMode', 'ExactOut');
    url.searchParams.set('excludeDexes', 'Pump.fun Amm');

    console.log('Jupiter quote request:', { inputMint, outputMint, amount, outputAmountSmallest, swapMode: 'ExactOut' });

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15000), // 15s timeout
    });

    const responseText = await response.clone().text().catch(() => '');
    console.log('Jupiter quote response:', responseText);

    if (!response.ok) {
      logger.error(`[Jupiter] Quote API error (${response.status}):`, responseText);
      return null;
    }

    const quote: any = await response.json();

    // Calculate estimated fee in SOL
    const estimatedFeeInSol = 0.000005; // ~5000 lamports per tx

    return {
      ...quote,
      estimatedFeeInSol,
    } as SwapQuote;
  } catch (error: any) {
    logger.error('[Jupiter] Error getting swap quote:', error.message);
    return null;
  }
}

// ─── Helper: Calculate Increasing Slippage ──────────────────

function getSlippageForAttempt(attempt: number): number {
  // Attempt 1: 1%, 2: 2%, 3: 3%, 4: 5%, 5: 10%
  const slippageMap: Record<number, number> = {
    1: 100,
    2: 200,
    3: 300,
    4: 500,
    5: 1000,
  };
  return slippageMap[attempt] || MAX_SLIPPAGE_BPS;
}

// ─── Build Non-Custodial Swap Transaction ───────────────────

/**
 * Build a swap transaction for non-custodial execution.
 * Sets up the transaction so:
 * - Customer's wallet is the source
 * - Merchant's wallet receives the output tokens
 * - useSharedAccounts auto-creates ATAs
 */
export async function buildNonCustodialSwapTx(
  quote: SwapQuote,
  customerWallet: string,
  merchantWallet: string
): Promise<string | null> {
  try {
    const swapResponse = await fetch(`${JUPITER_API_URL}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: customerWallet,           // Customer pays from here
        destinationTokenAccount: merchantWallet, // Merchant receives here
        useSharedAccounts: true,                 // Auto-create ATA if missing
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      }),
      signal: AbortSignal.timeout(30000), // 30s timeout
    });

    if (!swapResponse.ok) {
      const errText = await swapResponse.text();
      logger.error(`[Jupiter] Swap API error (${swapResponse.status}):`, errText);
      return null;
    }

    const swapData: any = await swapResponse.json();
    return swapData.swapTransaction || null;
  } catch (error: any) {
    logger.error('[Jupiter] Error building swap transaction:', error.message);
    return null;
  }
}

// ─── Swap Status ────────────────────────────────────────────

/**
 * Check the status of a swap by its transaction hash using real RPC.
 */
export async function getSwapStatus(txHash: string): Promise<{
  confirmed: boolean;
  slot?: number;
  error?: string;
}> {
  try {
    return await withFailover(async (connection) => {
      const status = await connection.getSignatureStatus(txHash, {
        searchTransactionHistory: true,
      });

      const value = status?.value;

      if (!value) {
        return { confirmed: false, error: 'Transaction not found' };
      }

      if (value.err) {
        return { confirmed: false, error: `Transaction failed: ${JSON.stringify(value.err)}` };
      }

      const isConfirmed =
        value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized';

      return {
        confirmed: isConfirmed,
        slot: value.slot,
      };
    });
  } catch (error: any) {
    return { confirmed: false, error: error.message };
  }
}

// ─── Process Swap If Needed (Non-Custodial) ─────────────────

/**
 * Check if a payment needs a swap and process it.
 * In non-custodial mode, the swap goes directly from customer to merchant.
 *
 * @param paymentId - The payment ID
 * @param receivedToken - The token actually received
 * @param receivedAmount - The amount actually received
 * @param merchantPreferredToken - What the merchant wants
 * @param customerWallet - Customer's wallet address
 * @param merchantWallet - Merchant's wallet address
 */
export async function processSwapIfNeeded(
  paymentId: string,
  receivedToken: string,
  receivedAmount: number,
  merchantPreferredToken: string,
  customerWallet?: string,
  merchantWallet?: string
): Promise<void> {
  if (receivedToken.toUpperCase() === merchantPreferredToken.toUpperCase()) {
    // No swap needed — mark as COMPLETED
    logger.info(`[Jupiter] No swap needed for payment ${paymentId}: ${receivedToken} matches merchant preference`);

    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    await prisma.paymentEvent.create({
      data: {
        paymentId,
        status: 'COMPLETED',
      },
    });

    return;
  }

  // Swap is needed
  logger.info(
    `[Jupiter] Swap needed for payment ${paymentId}: ${receivedToken} → ${merchantPreferredToken}`
  );

  await prisma.payment.update({
    where: { id: paymentId },
    data: {
      swapRequired: true,
      swappedFrom: receivedToken,
    },
  });

  // In non-custodial mode, we need customer to initiate the swap
  // The swap transaction will be built and sent to the customer for signing
  // Mark as CONFIRMED (waiting for swap execution)
  logger.info(`[Jupiter] Payment ${paymentId} marked as needing swap. Customer must approve.`);
}

// ─── Utility ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Common token mints — add more as needed
export const TOKEN_MINTS: Record<string, string> = {
  SOL:  'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  JUP:  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
};

// ─────────────────────────────────────────────
// getJupiterQuote (ExactOut by default for payments)
// ─────────────────────────────────────────────
export async function getJupiterQuote({ inputMint, outputMint, amount, slippageBps = 50, swapMode = 'ExactOut' }: { inputMint: string, outputMint: string, amount: number, slippageBps?: number, swapMode?: 'ExactIn' | 'ExactOut' }) {
  const resolvedInput  = TOKEN_MINTS[inputMint?.toUpperCase()]  || inputMint;
  const resolvedOutput = TOKEN_MINTS[outputMint?.toUpperCase()] || outputMint;

  const params = new URLSearchParams({
    inputMint:   resolvedInput,
    outputMint:  resolvedOutput,
    amount:      String(amount),
    slippageBps: String(slippageBps),
    swapMode,
    onlyDirectRoutes: 'false',
    asLegacyTransaction: 'false',
  });

  try {
    const res = await fetch(`${JUPITER_API_URL}/quote?${params}`);

    if (!res.ok) {
      const body = await res.text();
      logger.warn(`Jupiter quote failed: ${body}`, { inputMint: resolvedInput, outputMint: resolvedOutput });
      return null;
    }

    const quote: any = await res.json();

    logger.info(`Jupiter quote received for ${resolvedInput} to ${resolvedOutput} (${swapMode})`, {
      inAmount: quote.inAmount,
      outAmount: quote.outAmount,
      swapMode,
      priceImpactPct: quote.priceImpactPct,
    });

    return quote;
  } catch (err) {
    logger.error('Jupiter quote request threw', { err });
    return null;
  }
}

// ─────────────────────────────────────────────
// buildJupiterSwapTransaction
// ─────────────────────────────────────────────
export async function buildJupiterSwapTransaction({ quote, userPublicKey, destinationTokenAccount }: { quote: any, userPublicKey: string, destinationTokenAccount: string }) {
  try {
    const body = {
      quoteResponse: quote,
      userPublicKey,
      destinationTokenAccount,
      wrapAndUnwrapSol: true,
      useSharedAccounts: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    };

    const res = await fetch(`${JUPITER_API_URL}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      logger.error('Jupiter swap build failed', { errBody, userPublicKey });
      throw new Error(`Jupiter swap build failed: ${errBody}`);
    }

    const { swapTransaction, lastValidBlockHeight } = (await res.json()) as any;

    const transactionBuffer = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(transactionBuffer);

    logger.info('Jupiter swap tx built successfully', { userPublicKey, destinationTokenAccount });

    return { transaction, lastValidBlockHeight };
  } catch (err) {
    logger.error('buildJupiterSwapTransaction threw', { err, userPublicKey });
    throw err;
  }
}

// ─────────────────────────────────────────────
// getTokenBalances (with SOL buffer awareness)
// ─────────────────────────────────────────────
import { Connection } from '@solana/web3.js';
import { calculateSolBuffer } from '../utils/sol-buffer';

const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

export async function getTokenBalances(walletAddress: string) {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');

  try {
    const pubKey = new PublicKey(walletAddress);
    const solBalance = await connection.getBalance(pubKey);

    // Calculate SOL buffer so consumers know the actual swappable amount
    let solBuffer = 0;
    try {
      const bufferResult = await calculateSolBuffer();
      solBuffer = bufferResult.totalBufferLamports;
    } catch (err) {
      logger.warn('[Jupiter] Failed to calculate SOL buffer for getTokenBalances:', err);
      solBuffer = 5_000_000; // fallback: 0.005 SOL
    }

    const maxSwapLamports = Math.max(0, solBalance - solBuffer);

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      pubKey,
      { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
    );

    const balances = [
      {
        mint: TOKEN_MINTS.SOL,
        symbol: 'SOL',
        amount: solBalance,
        uiAmount: solBalance / 1e9,
        decimals: 9,
        maxSwapAmount: maxSwapLamports,         // lamports available for swap
        maxSwapUiAmount: maxSwapLamports / 1e9,  // SOL available for swap
        bufferReserved: solBuffer / 1e9,         // SOL reserved for fees
      },
    ];

    for (const account of tokenAccounts.value) {
      const info = account.account.data.parsed.info;
      if (info.tokenAmount.uiAmount > 0) {
        balances.push({
          mint: info.mint,
          symbol: Object.keys(TOKEN_MINTS).find(k => TOKEN_MINTS[k] === info.mint) || info.mint.slice(0, 6),
          amount: info.tokenAmount.amount,
          uiAmount: info.tokenAmount.uiAmount,
          decimals: info.tokenAmount.decimals,
          maxSwapAmount: info.tokenAmount.amount,   // Non-SOL tokens can be fully swapped
          maxSwapUiAmount: info.tokenAmount.uiAmount,
          bufferReserved: 0,
        });
      }
    }

    return balances;
  } catch (err) {
    logger.error('Failed to fetch token balances', { err, walletAddress });
    return [];
  }
}
