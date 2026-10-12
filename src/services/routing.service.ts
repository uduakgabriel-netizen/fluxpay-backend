import { logger } from '../utils/logger';
import { getMintAddress, getTokenBySymbol } from '../utils/token-registry';
import { getEscrowWalletPublicKey, getEscrowWalletKeypair, getGasWalletKeypair, getGasWalletPublicKey } from '../config/wallets';
import { getSwapQuote, SwapQuote } from './jupiter.service';
import { VersionedTransaction, PublicKey, TransactionMessage } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createTransferInstruction } from '@solana/spl-token';
import { getConnection, withFailover } from '../config/solana';
import { ValidationError, ProviderError } from '../errors/AppError';
import { CORE_SELLABLE_TOKENS } from './tokenRegistry.service';

const JUPITER_API_URL = process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v1';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export interface RouteHop {
  from: string;
  to: string;
  via: string;
}

export interface SettlementRoute {
  hops: RouteHop[];
  escrow?: boolean;
  batch?: string;
  destination: string | {
    provider: string;
    bankAccountId?: string | null;
    currency?: string | null;
  };
}

export interface JupiterOfframpQuote {
  quoteId?: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  slippageBps: number;
  routePlan?: any[];
  route: any;
}

function getJupiterHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (JUPITER_API_KEY) {
    headers['x-api-key'] = JUPITER_API_KEY;
  }
  return headers;
}

function resolveTokenDecimals(mint: string): number {
  const token = CORE_SELLABLE_TOKENS.find((t) => t.mint.toLowerCase() === mint.toLowerCase());
  if (token) return token.decimals;
  if (mint === USDC_MINT) return 6;
  if (mint.startsWith('So1')) return 9;
  if (mint.startsWith('Dez')) return 5;
  return 6;
}

function toSmallestUnits(amount: string | number, decimals: number): string {
  const str = String(amount);
  if (str.includes('.')) {
    const [whole, fraction = ''] = str.split('.');
    const padded = fraction.padEnd(decimals, '0').slice(0, decimals);
    const combined = (whole + padded).replace(/^0+/, '');
    return combined || '0';
  }
  const num = Number(str);
  if (num >= Math.pow(10, decimals)) {
    return str;
  }
  return (BigInt(str) * BigInt(Math.pow(10, decimals))).toString();
}

/**
 * PHASE 2.1: Robust Jupiter Routing
 * Fetches Jupiter quote from DEX aggregator with slippage check.
 * If priceImpactPct > 5%, throws ValidationError and blocks the swap.
 */
export async function getJupiterQuote(
  inputMint: string,
  outputMint: string = USDC_MINT,
  amount: string | number,
  slippageBps: number = 100
): Promise<JupiterOfframpQuote> {
  const inDecimals = resolveTokenDecimals(inputMint);
  const atomicAmount = toSmallestUnits(amount, inDecimals);

  let lastError: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const url = new URL(`${JUPITER_API_URL}/quote`);
      url.searchParams.set('inputMint', inputMint);
      url.searchParams.set('outputMint', outputMint);
      url.searchParams.set('amount', atomicAmount);
      url.searchParams.set('slippageBps', String(slippageBps));

      logger.info(`[Routing] Requesting Jupiter quote (attempt ${attempt}/3): ${inputMint} -> ${outputMint}, amount: ${atomicAmount}`);

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: getJupiterHeaders(),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Jupiter quote error (${response.status}): ${errText}`);
      }

      const data: any = await response.json();
      const priceImpact = parseFloat(data.priceImpactPct) || 0;

      // PHASE 5.2: Slippage Tolerance & Price Impact Check (> 5% blocked)
      if (priceImpact > 5.0) {
        logger.warn(`[Routing] High price impact detected (${priceImpact}%). Blocking swap.`);
        throw new ValidationError(
          `Price impact is too high (${priceImpact.toFixed(2)}% > 5.00%). Swap blocked to protect funds.`,
          'HIGH_PRICE_IMPACT'
        );
      }

      const outDecimals = resolveTokenDecimals(outputMint);
      const humanOutAmount = (Number(data.outAmount) / Math.pow(10, outDecimals)).toFixed(6);

      return {
        inputMint: data.inputMint,
        outputMint: data.outputMint,
        inAmount: String(amount),
        outAmount: humanOutAmount,
        priceImpactPct: priceImpact,
        slippageBps,
        routePlan: data.routePlan,
        route: data,
      };
    } catch (err: any) {
      if (err instanceof ValidationError) throw err;
      lastError = err;
      logger.warn(`[Routing] Quote attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 400));
      }
    }
  }

  // Fallback estimation if network is offline or simulated in test environment
  if (process.env.USE_MOCK_PROVIDERS === 'true' || process.env.NODE_ENV === 'test') {
    const fallbackRate = inputMint.startsWith('Dez') ? 0.00002 : inputMint.startsWith('So1') ? 150 : 1;
    const estOut = (Number(amount) * fallbackRate).toFixed(6);
    return {
      inputMint,
      outputMint,
      inAmount: String(amount),
      outAmount: estOut,
      priceImpactPct: 0.1,
      slippageBps,
      route: { inputMint, outputMint, inAmount: atomicAmount, outAmount: toSmallestUnits(estOut, 6) },
    };
  }

  throw new ProviderError(
    `Failed to fetch Jupiter quote: ${lastError?.message || 'Provider unavailable'}`,
    'jupiter'
  );
}

/**
 * PHASE 2.2 & 2.3: Gasless Fee Payer & Escrow Destination Routing
 * 1. Sets Gas Wallet as Fee Payer (user needs zero SOL)
 * 2. Routes swap output directly to FluxPay Escrow Wallet's USDC ATA
 * 3. Co-signs with Gas Wallet private key
 * 4. Returns serialized VersionedTransaction for user's wallet signature
 */
export async function buildGaslessSwapTransaction(params: {
  quoteResponse: any;
  userPublicKey: string;
  destinationTokenAccount?: string;
}): Promise<{
  serializedTransaction: string;
  gasWallet: string;
  escrowWallet: string;
  escrowAta: string;
}> {
  const { quoteResponse, userPublicKey } = params;

  const gasWallet = getGasWalletKeypair();
  const gasWalletPubkey = getGasWalletPublicKey();
  const escrowWalletPubkey = getEscrowWalletPublicKey();

  // Escrow Wallet's USDC Associated Token Account
  const usdcMintPubkey = new PublicKey(USDC_MINT);
  const escrowAta = getAssociatedTokenAddressSync(usdcMintPubkey, escrowWalletPubkey, true);
  const destinationAta = params.destinationTokenAccount || escrowAta.toBase58();

  let lastError: any = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const payload: any = {
        quoteResponse,
        userPublicKey,
        destinationTokenAccount: destinationAta,
        payer: gasWalletPubkey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      };

      logger.info(`[Routing] Requesting Jupiter swap transaction with Gas Wallet payer ${gasWalletPubkey.toBase58()}`);

      const response = await fetch(`${JUPITER_API_URL}/swap`, {
        method: 'POST',
        headers: getJupiterHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Jupiter swap error (${response.status}): ${errText}`);
      }

      const data: any = await response.json();
      if (!data.swapTransaction) {
        throw new Error('Jupiter did not return swapTransaction');
      }

      // Deserialize VersionedTransaction and sign with Gas Wallet keypair
      const txBuf = Buffer.from(data.swapTransaction, 'base64');
      const versionedTx = VersionedTransaction.deserialize(txBuf);

      // Gas Wallet signs as Fee Payer if marked as a required signer
      const numSigners = versionedTx.message.header.numRequiredSignatures;
      const isSigner = versionedTx.message.staticAccountKeys
        .slice(0, numSigners)
        .some((k) => k.equals(gasWalletPubkey));

      if (isSigner) {
        versionedTx.sign([gasWallet]);
        logger.info(`[Routing] Gas Wallet signed as sponsor/payer`);
      } else {
        logger.warn(`[Routing] Gas Wallet ${gasWalletPubkey.toBase58()} not marked as signer by Jupiter`);
      }

      const partiallySignedBase64 = Buffer.from(versionedTx.serialize()).toString('base64');

      return {
        serializedTransaction: partiallySignedBase64,
        gasWallet: gasWalletPubkey.toBase58(),
        escrowWallet: escrowWalletPubkey.toBase58(),
        escrowAta: destinationAta,
      };
    } catch (err: any) {
      lastError = err;
      logger.warn(`[Routing] buildGaslessSwapTransaction attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 400));
      }
    }
  }

  // Fallback simulation in test mode
  if (process.env.USE_MOCK_PROVIDERS === 'true' || process.env.NODE_ENV === 'test') {
    const mockTxBase64 = Buffer.from(`mock_gasless_tx_${Date.now()}_${userPublicKey.slice(0, 6)}`).toString('base64');
    return {
      serializedTransaction: mockTxBase64,
      gasWallet: gasWalletPubkey.toBase58(),
      escrowWallet: escrowWalletPubkey.toBase58(),
      escrowAta: destinationAta,
    };
  }

  throw new ProviderError(
    `Failed to build gasless swap transaction: ${lastError?.message}`,
    'jupiter'
  );
}

/**
 * Broadcast fully signed transaction to Solana RPC via Helius / failover
 */
export async function broadcastSignedTransaction(signedTransactionBase64: string): Promise<{ txHash: string }> {
  if (process.env.USE_MOCK_PROVIDERS === 'true' || process.env.NODE_ENV === 'test') {
    return { txHash: `sig_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
  }

  try {
    const txBuf = Buffer.from(signedTransactionBase64, 'base64');
    const versionedTx = VersionedTransaction.deserialize(txBuf);

    const signature = await withFailover(async (connection) => {
      return await connection.sendTransaction(versionedTx, {
        maxRetries: 3,
        skipPreflight: false,
      });
    });

    logger.info(`[Routing] Transaction broadcasted with signature: ${signature}`);
    return { txHash: signature };
  } catch (err: any) {
    logger.error(`[Routing] broadcastSignedTransaction failed: ${err.message}`);
    throw new ProviderError(`Failed to broadcast transaction: ${err.message}`, 'solana-rpc');
  }
}

/**
 * Builds the settlement route for a payment based on merchant preference.
 */
export function buildSettlementRoute(payment: any, merchant: any): SettlementRoute {
  const customerToken = (payment.customerToken || payment.swappedFrom || payment.token || 'SOL').toUpperCase();
  const settlementType = (merchant.settlementType || 'CRYPTO').toUpperCase();
  const preferredToken = (merchant.preferredToken || merchant.preferredTokenSymbol || 'USDC').toUpperCase();
  const merchantWallet = merchant.walletAddress;

  if (settlementType === 'CRYPTO') {
    if (preferredToken === 'USDC') {
      return {
        hops: [{ from: customerToken, to: 'USDC', via: 'Jupiter' }],
        destination: merchantWallet,
      };
    } else {
      return {
        hops: [
          { from: customerToken, to: 'USDC', via: 'Jupiter' },
          { from: 'USDC', to: preferredToken, via: 'Jupiter' },
        ],
        destination: merchantWallet,
      };
    }
  }

  if (settlementType === 'FIAT') {
    const currency = merchant.settlementCurrency || merchant.currency || 'NGN';
    const provider = currency === 'NGN' ? 'Monnify' : 'Transak';
    return {
      hops: [{ from: customerToken, to: 'USDC', via: 'Jupiter' }],
      escrow: true,
      batch: merchant.id,
      destination: {
        provider,
        bankAccountId: merchant.defaultPayoutAccountId,
        currency,
      },
    };
  }

  // Default fallback: direct to merchant wallet
  return {
    hops: [{ from: customerToken, to: preferredToken, via: 'Jupiter' }],
    destination: merchantWallet,
  };
}

/**
 * Get the destination wallet address for a swap:
 * - For FIAT merchants: Output to FluxPay Escrow Wallet
 * - For CRYPTO merchants: Output directly to merchant's wallet
 */
export function getSwapDestinationAddress(merchant: any): string {
  if (merchant.settlementType === 'FIAT') {
    return getEscrowWalletPublicKey().toBase58();
  }
  return merchant.walletAddress;
}

/**
 * Verify multi-hop Jupiter route feasibility
 */
export async function verifyMultiHopRoute(
  fromToken: string,
  toToken: string,
  amount: number
): Promise<{ success: boolean; hops: RouteHop[]; quote?: any; error?: string }> {
  try {
    const hops: RouteHop[] =
      toToken === 'USDC' || fromToken === 'USDC'
        ? [{ from: fromToken, to: toToken, via: 'Jupiter' }]
        : [
            { from: fromToken, to: 'USDC', via: 'Jupiter' },
            { from: 'USDC', to: toToken, via: 'Jupiter' },
          ];

    const quote = await getSwapQuote(fromToken, toToken, amount);
    if (!quote) {
      return { success: false, hops, error: `No Jupiter route found for ${fromToken} → ${toToken}` };
    }

    return { success: true, hops, quote };
  } catch (err: any) {
    logger.error(`[Routing] verifyMultiHopRoute failed: ${err.message}`);
    return { success: false, hops: [], error: err.message };
  }
}

/**
 * Refund USDC from Escrow Wallet back to user wallet if fiat disbursement fails
 */
export async function refundEscrowToUser(params: {
  userWalletAddress: string;
  usdcAmount: string | number;
}): Promise<{ txHash: string }> {
  const { userWalletAddress, usdcAmount } = params;

  if (process.env.USE_MOCK_PROVIDERS === 'true' || process.env.NODE_ENV === 'test') {
    return { txHash: `refund_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` };
  }

  try {
    const escrowKeypair = getEscrowWalletKeypair();
    const gasKeypair = getGasWalletKeypair();
    const usdcMintPubkey = new PublicKey(USDC_MINT);
    const userPubkey = new PublicKey(userWalletAddress);

    const escrowAta = getAssociatedTokenAddressSync(usdcMintPubkey, escrowKeypair.publicKey, true);
    const userAta = getAssociatedTokenAddressSync(usdcMintPubkey, userPubkey, true);

    const atomicAmount = BigInt(Math.floor(Number(usdcAmount) * 1e6));

    const transferIx = createTransferInstruction(
      escrowAta,
      userAta,
      escrowKeypair.publicKey,
      atomicAmount
    );

    const latestBlockhash = await withFailover(async (conn) => conn.getLatestBlockhash('confirmed'));

    const messageV0 = new TransactionMessage({
      payerKey: gasKeypair.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [transferIx],
    }).compileToV0Message();

    const versionedTx = new VersionedTransaction(messageV0);
    versionedTx.sign([gasKeypair, escrowKeypair]);

    const txSignature = await withFailover(async (conn) => {
      return await conn.sendTransaction(versionedTx, { maxRetries: 3, skipPreflight: false });
    });

    logger.info(`[Routing] Refunded ${usdcAmount} USDC to ${userWalletAddress}: ${txSignature}`);
    return { txHash: txSignature };
  } catch (err: any) {
    logger.error(`[Routing] refundEscrowToUser error: ${err.message}`);
    return { txHash: `refund_failed_${Date.now()}` };
  }
}

