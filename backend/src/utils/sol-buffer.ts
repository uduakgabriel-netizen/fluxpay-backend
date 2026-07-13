/**
 * SOL Buffer Utility
 *
 * Calculates the minimum SOL that must remain in a wallet to cover:
 * 1. Rent exemption for token accounts (~0.00203 SOL for 165-byte account)
 * 2. Transaction network fee (~0.000005 SOL per signature)
 * 3. Priority fee buffer for faster confirmation
 * 4. Safety margin for edge cases (multiple ATAs, etc.)
 *
 * This buffer is a RESERVATION, not an extra charge. The customer keeps
 * the buffer in their wallet — only the swap amount is deducted.
 *
 * Without this buffer, non-USDC swaps fail with "Insufficient funds"
 * because the transaction fee must be paid in SOL regardless of the
 * token being swapped.
 */

import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getConnection, getRecommendedPriorityFee } from '../config/solana';
import { logger } from '../utils/logger';

// ─── Constants ──────────────────────────────────────────────

/** Safety buffer for network fees (in SOL) — covers ~400 transactions */
const NETWORK_FEE_BUFFER_SOL = 0.002;

/** Size in bytes of a standard SPL Token Account (used for rent calc) */
const TOKEN_ACCOUNT_SIZE_BYTES = 165;

/** Default rent exemption in lamports if RPC call fails (~0.00203 SOL) */
const DEFAULT_RENT_EXEMPTION_LAMPORTS = 2_039_280;

/** Default compute units per swap transaction */
const DEFAULT_COMPUTE_UNITS = 200_000;

/** Maximum buffer cap to avoid over-reserving (in SOL) */
const MAX_BUFFER_SOL = 0.01;

// ─── Core Buffer Calculation ────────────────────────────────

export interface SolBufferResult {
  /** Total buffer in SOL to reserve */
  totalBufferSol: number;
  /** Total buffer in lamports */
  totalBufferLamports: number;
  /** Rent exemption component (SOL) */
  rentExemptionSol: number;
  /** Network fee component (SOL) */
  networkFeeSol: number;
  /** Priority fee component (SOL) */
  priorityFeeSol: number;
  /** Safety margin component (SOL) */
  safetyMarginSol: number;
}

/**
 * Calculate the required SOL buffer for a swap transaction.
 *
 * This fetches live data from the Solana RPC:
 * - Rent exemption minimum for a token account (165 bytes)
 * - Current priority fee from recent blocks
 *
 * Falls back to safe defaults if RPC calls fail.
 */
export async function calculateSolBuffer(): Promise<SolBufferResult> {
  let rentExemptionLamports = DEFAULT_RENT_EXEMPTION_LAMPORTS;
  let priorityFeeMicroLamports = 1_000; // default

  try {
    const connection = getConnection();

    // 1. Get rent exemption for a token account (165 bytes)
    rentExemptionLamports = await connection.getMinimumBalanceForRentExemption(
      TOKEN_ACCOUNT_SIZE_BYTES
    );

    logger.debug(`[SolBuffer] Rent exemption: ${rentExemptionLamports} lamports (${rentExemptionLamports / LAMPORTS_PER_SOL} SOL)`);
  } catch (err: any) {
    logger.warn(`[SolBuffer] Failed to fetch rent exemption, using default: ${err.message}`);
  }

  try {
    // 2. Get current priority fee
    priorityFeeMicroLamports = await getRecommendedPriorityFee();
    logger.debug(`[SolBuffer] Priority fee: ${priorityFeeMicroLamports} micro-lamports/CU`);
  } catch (err: any) {
    logger.warn(`[SolBuffer] Failed to fetch priority fee, using default: ${err.message}`);
  }

  // 3. Calculate priority fee in lamports
  // priorityFee = computeUnitPrice (micro-lamports/CU) × computeUnits / 1_000_000
  const priorityFeeLamports = Math.ceil(
    (priorityFeeMicroLamports * DEFAULT_COMPUTE_UNITS) / 1_000_000
  );

  // 4. Convert to SOL
  const rentExemptionSol = rentExemptionLamports / LAMPORTS_PER_SOL;
  const priorityFeeSol = priorityFeeLamports / LAMPORTS_PER_SOL;
  const networkFeeSol = NETWORK_FEE_BUFFER_SOL;
  const safetyMarginSol = 0.001; // extra margin for ATA creation, etc.

  // 5. Total buffer (capped at MAX_BUFFER_SOL)
  const rawTotal = rentExemptionSol + networkFeeSol + priorityFeeSol + safetyMarginSol;
  const totalBufferSol = Math.min(rawTotal, MAX_BUFFER_SOL);
  const totalBufferLamports = Math.ceil(totalBufferSol * LAMPORTS_PER_SOL);

  logger.info(`[SolBuffer] Calculated buffer: ${totalBufferSol.toFixed(6)} SOL (rent: ${rentExemptionSol.toFixed(6)}, network: ${networkFeeSol}, priority: ${priorityFeeSol.toFixed(6)}, safety: ${safetyMarginSol})`);

  return {
    totalBufferSol,
    totalBufferLamports,
    rentExemptionSol,
    networkFeeSol,
    priorityFeeSol,
    safetyMarginSol,
  };
}

/**
 * Calculate the maximum amount of SOL a wallet can use for a swap,
 * after reserving the buffer for fees and rent.
 *
 * @param walletBalanceLamports - The wallet's current SOL balance in lamports
 * @returns The maximum swappable SOL (in human-readable units), or 0 if insufficient
 */
export async function getMaxSwapAmountSol(
  walletBalanceLamports: number
): Promise<{ maxSwapAmountSol: number; buffer: SolBufferResult; sufficient: boolean }> {
  const buffer = await calculateSolBuffer();

  const availableLamports = walletBalanceLamports - buffer.totalBufferLamports;
  const maxSwapAmountSol = Math.max(0, availableLamports / LAMPORTS_PER_SOL);
  const sufficient = availableLamports > 0;

  return { maxSwapAmountSol, buffer, sufficient };
}

/**
 * Check if a wallet has enough SOL to cover the buffer (for any token swap).
 * Every swap requires SOL for transaction fees, even if paying with BONK/JUP/etc.
 *
 * @param walletBalanceLamports - The wallet's current SOL balance in lamports
 * @returns Whether the wallet has enough SOL for fees
 */
export async function hasEnoughSolForFees(
  walletBalanceLamports: number
): Promise<{ sufficient: boolean; buffer: SolBufferResult; shortfall: number }> {
  const buffer = await calculateSolBuffer();
  const shortfallLamports = Math.max(0, buffer.totalBufferLamports - walletBalanceLamports);
  const shortfall = shortfallLamports / LAMPORTS_PER_SOL;

  return {
    sufficient: shortfallLamports === 0,
    buffer,
    shortfall,
  };
}
