import { logger } from '../utils/logger';
/**
 * Non-Custodial Swap Service — PRODUCTION
 *
 * Core logic for FluxPay's non-custodial payment processing.
 *
 * Key principle: FluxPay NEVER holds customer funds.
 *
 * Flow:
 * 1. Customer connects wallet on checkout page
 * 2. FluxPay gets a Jupiter quote (customerWallet → merchantWallet)
 * 3. Customer signs the swap transaction
 * 4. FluxPay co-signs (to pay gas fees) and submits to Solana
 * 5. Merchant receives swapped tokens directly
 *
 * Retry strategy:
 * - 5 attempts with increasing slippage: 1% → 2% → 3% → 5% → 10%
 * - Delays between retries: 5s, 5s, 10s, 15s
 * - After all retries fail: mark FAILED, send Discord alert
 */

import {
  Keypair,
  PublicKey,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { PrismaClient } from '@prisma/client';
import { getMintAddress, getTokenBySymbol } from '../utils/token-registry';
import { getConnection, withFailover } from '../config/solana';
import { AlertService } from './alert.service';
import { ensureTokenAccountExists } from '../utils/ensure-token-account';

const prisma = new PrismaClient();

const JUPITER_API_URL = process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v2';
const MAX_SWAP_RETRIES = 5;
const INITIAL_SLIPPAGE_BPS = 100; // 1%
const MIN_MERCHANT_SOL_BALANCE = 0.005; // Minimum SOL for ATA rent

// Retry delays: 5s, 5s, 10s, 15s (between attempts)
const RETRY_DELAYS_MS = [5000, 5000, 10000, 15000];

// ─── Interfaces ─────────────────────────────────────────────

export interface NonCustodialSwapQuote {
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

export interface NonCustodialSwapResult {
  success: boolean;
  txHash?: string;
  inputAmount: number;
  outputAmount: number;
  fee: number;
  error?: string;
  serializedTransaction?: string; // Base64 serialized tx for client signing
}

// ─── Helper: Load FluxPay Gas Wallet ────────────────────────

function loadFluxPayGasWallet(): Keypair {
  const key = process.env.FLUXPAY_WALLET_PRIVATE_KEY;
  if (!key) {
    throw new Error('FLUXPAY_WALLET_PRIVATE_KEY is not configured');
  }

  try {
    if (key.startsWith('[')) {
      const parsed = JSON.parse(key);
      return Keypair.fromSecretKey(new Uint8Array(parsed));
    }
    // Support base64
    if (key.length > 100) {
      return Keypair.fromSecretKey(new Uint8Array(Buffer.from(key, 'base64')));
    }
    return Keypair.fromSecretKey(new Uint8Array(Buffer.from(key, 'hex')));
  } catch (error: any) {
    throw new Error(`Invalid FLUXPAY_WALLET_PRIVATE_KEY format: ${error.message}`);
  }
}

// ─── Check Merchant SOL Balance ─────────────────────────────

/**
 * Verify the merchant wallet has enough SOL for ATA rent.
 * Returns false with a clear error if insufficient.
 */
export async function checkMerchantSolBalance(
  merchantWallet: string
): Promise<{ sufficient: boolean; balance: number; error?: string }> {
  try {
    return await withFailover(async (connection) => {
      const pubkey = new PublicKey(merchantWallet);
      const balanceLamports = await connection.getBalance(pubkey);
      const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

      if (balanceSol < MIN_MERCHANT_SOL_BALANCE) {
        return {
          sufficient: false,
          balance: balanceSol,
          error: `Merchant wallet needs at least ${MIN_MERCHANT_SOL_BALANCE} SOL for first-time token receipt. Current balance: ${balanceSol.toFixed(6)} SOL`,
        };
      }

      return { sufficient: true, balance: balanceSol };
    });
  } catch (error: any) {
    return {
      sufficient: false,
      balance: 0,
      error: `Failed to check merchant SOL balance: ${error.message}`,
    };
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
  return slippageMap[attempt] || 1000;
}

// ─── Get Non-Custodial Swap Quote (ExactOut) ────────────────

/**
 * Get a swap quote for a non-custodial swap using ExactOut mode.
 *
 * For payments, the merchant specifies the exact output amount they want.
 * Jupiter calculates how much input the buyer needs to send.
 *
 * @param fromToken - Buyer's token symbol (e.g., "BONK")
 * @param toToken - Merchant's desired token symbol (e.g., "USDC")
 * @param amount - Exact amount the merchant wants to RECEIVE (human-readable)
 * @param slippageBps - Slippage tolerance in basis points
 */
export async function getNonCustodialQuote(
  fromToken: string,
  toToken: string,
  amount: number,
  slippageBps: number = INITIAL_SLIPPAGE_BPS
): Promise<NonCustodialSwapQuote | null> {
  const inputMint = getMintAddress(fromToken);
  const outputMint = getMintAddress(toToken);

  if (!inputMint || !outputMint) {
    logger.error(`[NonCustodial] Unknown token: ${fromToken} or ${toToken}`);
    return null;
  }

  // ExactOut: amount is the desired OUTPUT, so use the OUTPUT token's decimals
  const toTokenInfo = getTokenBySymbol(toToken);
  if (!toTokenInfo) {
    logger.error(`[NonCustodial] Unknown output token: ${toToken}`);
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

    logger.info(`[NonCustodial] Getting ExactOut quote: merchant wants ${amount} ${toToken} (${outputAmountSmallest} smallest), buyer pays with ${fromToken} (slippage: ${slippageBps}bps)`);

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error(`[NonCustodial] Quote API error (${response.status}):`, errText);
      return null;
    }

    const quote: any = await response.json();

    return {
      ...quote,
      estimatedFeeInSol: 0.000005, // ~5000 lamports per tx
    } as NonCustodialSwapQuote;
  } catch (error: any) {
    logger.error('[NonCustodial] Error getting swap quote:', error.message);
    return null;
  }
}

// ─── Build Non-Custodial Swap Transaction ───────────────────

/**
 * Build a swap transaction for the customer to sign.
 * This is the core non-custodial function:
 * - Customer's wallet is the source (userPublicKey)
 * - Merchant's wallet is the destination (destinationTokenAccount)
 * - useSharedAccounts: true auto-creates ATAs
 * - FluxPay pays gas fees via feeAccount
 */
export async function buildSwapTransaction(
  customerWallet: string,
  merchantWallet: string,
  fromToken: string,
  toToken: string,
  amount: number,
  slippageBps: number = INITIAL_SLIPPAGE_BPS
): Promise<{
  serializedTransaction: string;
  quote: NonCustodialSwapQuote;
  outputAmount: number;
} | null> {
  // 1. Get ExactOut quote — amount is what the merchant wants to receive
  const quote = await getNonCustodialQuote(fromToken, toToken, amount, slippageBps);
  if (!quote) return null;

  // In ExactOut mode:
  //   - outAmount = the fixed output the merchant receives
  //   - inAmount = the variable input the buyer must send
  const toTokenInfo = getTokenBySymbol(toToken);
  const outputAmount = Number(quote.outAmount) / Math.pow(10, toTokenInfo?.decimals || 6);
  const fromTokenInfo = getTokenBySymbol(fromToken);
  const inputAmountHuman = Number(quote.inAmount) / Math.pow(10, fromTokenInfo?.decimals || 6);

  logger.info(`[NonCustodial] ExactOut quote: buyer sends ~${inputAmountHuman} ${fromToken}, merchant receives ${outputAmount} ${toToken}`);

  // 2. Pre-create ATAs if needed (Fix 2: prevents Jupiter error 6024)
  try {
    const resolvedOutputMint = getMintAddress(toToken);
    if (resolvedOutputMint) {
      const gasWallet = loadFluxPayGasWallet();

      // Ensure merchant has ATA for the output token
      const merchantATAResult = await ensureTokenAccountExists(
        merchantWallet,
        resolvedOutputMint,
        gasWallet
      );
      if (merchantATAResult.created) {
        logger.info(`[NonCustodial] Created merchant ATA for ${toToken} (tx: ${merchantATAResult.txSignature})`);
      }
    }
  } catch (ataErr: any) {
    // Non-fatal: Jupiter may handle via useSharedAccounts
    logger.warn(`[NonCustodial] ATA pre-creation failed (non-fatal): ${ataErr.message}`);
  }

  // 3. Build swap transaction with non-custodial parameters
  try {
    const swapRequestBody: any = {
      quoteResponse: quote,
      userPublicKey: customerWallet,           // Customer pays from here
      destinationTokenAccount: merchantWallet, // Merchant receives here
      useSharedAccounts: true,                 // Auto-create ATA if missing
      wrapAndUnwrapSol: true,                  // Fix 1: Handle SOL wrapping
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    };

    logger.info(`[NonCustodial] Building swap tx: ${customerWallet.slice(0, 8)}... → ${merchantWallet.slice(0, 8)}...`);

    const swapResponse = await fetch(`${JUPITER_API_URL}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(swapRequestBody),
      signal: AbortSignal.timeout(30000),
    });

    if (!swapResponse.ok) {
      const errText = await swapResponse.text();
      logger.error(`[NonCustodial] Swap API error (${swapResponse.status}):`, errText);
      return null;
    }

    const swapData: any = await swapResponse.json();

    if (!swapData.swapTransaction) {
      logger.error('[NonCustodial] No swap transaction returned from Jupiter');
      return null;
    }

    return {
      serializedTransaction: swapData.swapTransaction,
      quote,
      outputAmount,
    };
  } catch (error: any) {
    logger.error('[NonCustodial] Error building swap transaction:', error.message);
    return null;
  }
}

// ─── Execute Non-Custodial Swap ─────────────────────────────

/**
 * Execute a non-custodial swap with retry logic.
 *
 * This function:
 * 1. Checks merchant SOL balance (for ATA rent)
 * 2. Gets quote from Jupiter with increasing slippage
 * 3. Builds swap transaction (customer→merchant)
 * 4. Signs with FluxPay gas wallet (for gas fees only)
 * 5. Sends to Solana and waits for confirmation
 * 6. Retries up to 5 times with increasing slippage
 *
 * NOTE: In production, the customer signs the transaction on the frontend.
 * This server-side execution is used when we have a pre-signed transaction
 * or for backend-initiated retries with a new quote.
 */
export async function executeNonCustodialSwap(
  customerWallet: string,
  merchantWallet: string,
  fromToken: string,
  toToken: string,
  amount: number,
  paymentId: string,
  signedTransactionBase64?: string // Pre-signed by customer on frontend
): Promise<NonCustodialSwapResult> {
  logger.info(`[NonCustodial] Executing swap: ${amount} ${fromToken} → ${toToken} for payment ${paymentId}`);
  logger.info(`[NonCustodial] Customer: ${customerWallet.slice(0, 8)}... → Merchant: ${merchantWallet.slice(0, 8)}...`);

  // Check merchant SOL balance before attempting swap
  const balanceCheck = await checkMerchantSolBalance(merchantWallet);
  if (!balanceCheck.sufficient) {
    logger.error(`[NonCustodial] ${balanceCheck.error}`);

    // Alert admin about low merchant SOL
    await AlertService.alertLowMerchantSol(
      merchantWallet,
      balanceCheck.balance,
      paymentId
    ).catch(logger.error);

    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'FAILED',
        lastSwapError: balanceCheck.error,
        adminAlertSent: true,
      },
    });

    return {
      success: false,
      inputAmount: amount,
      outputAmount: 0,
      fee: 0,
      error: balanceCheck.error,
    };
  }

  let lastError = '';

  // If we have a pre-signed transaction from the customer, submit it directly
  if (signedTransactionBase64) {
    try {
      const txBuf = Buffer.from(signedTransactionBase64, 'base64');
      const transaction = VersionedTransaction.deserialize(txBuf);

      const connection = getConnection();
      const rawTransaction = transaction.serialize();

      const txHash = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
        maxRetries: 2,
      });

      logger.info(`[NonCustodial] Pre-signed tx sent: ${txHash.slice(0, 12)}...`);

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash('confirmed');

      const confirmation = await connection.confirmTransaction(
        { signature: txHash, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      if (confirmation.value.err) {
        lastError = `Pre-signed transaction failed: ${JSON.stringify(confirmation.value.err)}`;
        logger.error(`[NonCustodial] ${lastError}`);
      } else {
        // Success!
        const toTokenInfo = getTokenBySymbol(toToken);
        const fee = amount * 0.003; // 0.3% platform fee

        await updatePaymentSuccess(paymentId, txHash, fromToken, amount, fee);

        logger.info(`[NonCustodial] ✓ Pre-signed swap completed: ${txHash}`);

        return {
          success: true,
          txHash,
          inputAmount: amount,
          outputAmount: amount, // Will be updated by the actual output
          fee,
        };
      }
    } catch (error: any) {
      lastError = error.message || 'Pre-signed transaction error';
      logger.error(`[NonCustodial] Pre-signed tx failed:`, lastError);
    }
  }

  // Server-side retry logic (for retries when customer isn't present)
  for (let attempt = 1; attempt <= MAX_SWAP_RETRIES; attempt++) {
    try {
      logger.info(`[NonCustodial] Swap attempt ${attempt}/${MAX_SWAP_RETRIES}...`);

      const slippageBps = getSlippageForAttempt(attempt);
      const swapData = await buildSwapTransaction(
        customerWallet,
        merchantWallet,
        fromToken,
        toToken,
        amount,
        slippageBps
      );

      if (!swapData) {
        lastError = `Attempt ${attempt}: Failed to build swap transaction`;
        logger.error(`[NonCustodial] ${lastError}`);
        if (attempt < MAX_SWAP_RETRIES) {
          await sleep(RETRY_DELAYS_MS[attempt - 1] || 5000);
        }
        continue;
      }

      // Check minimum output to avoid dust
      if (swapData.outputAmount < 0.001) {
        lastError = `Output amount too small: ${swapData.outputAmount} ${toToken}`;
        logger.error(`[NonCustodial] ${lastError}`);
        break;
      }

      logger.info(`[NonCustodial] Quote: ${amount} ${fromToken} → ${swapData.outputAmount} ${toToken}`);

      // Deserialize and sign with FluxPay gas wallet
      const txBuf = Buffer.from(swapData.serializedTransaction, 'base64');
      const transaction = VersionedTransaction.deserialize(txBuf);

      // FluxPay gas wallet signs to pay for gas fees
      const gasWallet = loadFluxPayGasWallet();
      transaction.sign([gasWallet]);

      // Send to Solana
      const connection = getConnection();
      const rawTransaction = transaction.serialize();

      const txHash = await connection.sendRawTransaction(rawTransaction, {
        skipPreflight: true,
        maxRetries: 2,
      });

      logger.info(`[NonCustodial] Tx sent: ${txHash.slice(0, 12)}... — waiting for confirmation...`);

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash('confirmed');

      const confirmation = await connection.confirmTransaction(
        { signature: txHash, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      if (confirmation.value.err) {
        lastError = `Attempt ${attempt}: Transaction confirmed but failed: ${JSON.stringify(confirmation.value.err)}`;
        logger.error(`[NonCustodial] ${lastError}`);
        if (attempt < MAX_SWAP_RETRIES) {
          await sleep(RETRY_DELAYS_MS[attempt - 1] || 5000);
        }
        continue;
      }

      // Swap succeeded!
      const fee = amount * 0.003; // 0.3% platform fee

      await updatePaymentSuccess(paymentId, txHash, fromToken, swapData.outputAmount, fee, attempt);

      logger.info(`[NonCustodial] ✓ Swap completed on attempt ${attempt}: ${txHash}`);

      await AlertService.alertSwapSuccess(paymentId, txHash, amount, swapData.outputAmount).catch(logger.error);

      return {
        success: true,
        txHash,
        inputAmount: amount,
        outputAmount: swapData.outputAmount,
        fee,
      };
    } catch (error: any) {
      lastError = error.message || 'Unknown swap error';
      logger.error(`[NonCustodial] Attempt ${attempt}/${MAX_SWAP_RETRIES} failed:`, lastError);

      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          swapRetries: attempt,
          lastSwapError: lastError,
          lastSwapRetryAt: new Date(),
        },
      });

      if (attempt < MAX_SWAP_RETRIES) {
        await sleep(RETRY_DELAYS_MS[attempt - 1] || 5000);
      }
    }
  }

  // All retries failed
  logger.error(`[NonCustodial] ✗ Swap failed after ${MAX_SWAP_RETRIES} attempts for payment ${paymentId}`);

  await prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: 'FAILED',
      swapRetries: MAX_SWAP_RETRIES,
      lastSwapError: `Swap failed after ${MAX_SWAP_RETRIES} attempts. Last error: ${lastError}`,
      lastSwapRetryAt: new Date(),
      adminAlertSent: true,
    },
  });

  await prisma.paymentEvent.create({
    data: { paymentId, status: 'FAILED' },
  });

  // Discord Alert
  await AlertService.alertSwapFailure(
    paymentId,
    `Swap failed after ${MAX_SWAP_RETRIES} attempts. Last error: ${lastError}`,
    MAX_SWAP_RETRIES
  ).catch(logger.error);

  return {
    success: false,
    inputAmount: amount,
    outputAmount: 0,
    fee: 0,
    error: `Swap failed after ${MAX_SWAP_RETRIES} attempts: ${lastError}`,
  };
}

// ─── Process Non-Custodial Swap If Needed ───────────────────

/**
 * Determine if a swap is needed and execute it non-custodially.
 * Called after customer confirms payment intent.
 */
export async function processNonCustodialSwapIfNeeded(
  paymentId: string,
  customerWallet: string,
  merchantWallet: string,
  receivedToken: string,
  receivedAmount: number,
  merchantPreferredToken: string,
  signedTransactionBase64?: string
): Promise<void> {
  if (receivedToken.toUpperCase() === merchantPreferredToken.toUpperCase()) {
    // No swap needed — mark as COMPLETED directly
    logger.info(`[NonCustodial] No swap needed for payment ${paymentId}: tokens match`);

    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    await prisma.paymentEvent.create({
      data: { paymentId, status: 'COMPLETED' },
    });

    return;
  }

  // Swap is needed
  logger.info(
    `[NonCustodial] Swap needed for payment ${paymentId}: ${receivedToken} → ${merchantPreferredToken}`
  );

  await prisma.payment.update({
    where: { id: paymentId },
    data: {
      swapRequired: true,
      swappedFrom: receivedToken,
    },
  });

  const result = await executeNonCustodialSwap(
    customerWallet,
    merchantWallet,
    receivedToken,
    merchantPreferredToken,
    receivedAmount,
    paymentId,
    signedTransactionBase64
  );

  if (result.success) {
    await prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });

    await prisma.paymentEvent.create({
      data: { paymentId, status: 'COMPLETED' },
    });

    logger.info(`[NonCustodial] ✓ Payment ${paymentId} completed after swap`);
  }
  // If swap failed, executeNonCustodialSwap already marked it as FAILED
}

// ─── Helper: Update Payment on Successful Swap ─────────────

async function updatePaymentSuccess(
  paymentId: string,
  txHash: string,
  fromToken: string,
  outputAmount: number,
  fee: number,
  attempt: number = 1
): Promise<void> {
  await prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: 'COMPLETED',
      swapTxHash: txHash,
      swappedFrom: fromToken,
      swappedAmount: outputAmount,
      swapFee: fee,
      swapRetries: attempt,
      lastSwapError: null,
      lastSwapRetryAt: new Date(),
      completedAt: new Date(),
    },
  });

  await prisma.paymentEvent.create({
    data: { paymentId, status: 'COMPLETED' },
  });
}

// ─── Utility ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
