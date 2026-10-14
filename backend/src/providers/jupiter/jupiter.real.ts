import {
  JupiterAdapter,
  JupiterSwapQuoteParams,
  JupiterSwapQuoteResult,
  BuildSwapTxParams,
  BuildSwapTxResult,
  SubmitSwapResult,
} from './jupiter.adapter';
import { VersionedTransaction } from '@solana/web3.js';
import { getConnection, withFailover } from '../../config/solana';
import { logger } from '../../utils/logger';
import { ProviderError } from '../../errors/AppError';
import { CORE_SELLABLE_TOKENS } from '../../services/tokenRegistry.service';

const JUPITER_API_URL = process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v1';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY;

// Cache recently generated quotes to be reused by buildSwapTransaction
const quoteCache = new Map<string, { quote: any; cachedAt: number }>();

function getHeaders(): Record<string, string> {
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
  return token?.decimals ?? 6;
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
  // If already in atomic units (e.g. > 10,000 for standard amounts)
  if (num >= Math.pow(10, decimals)) {
    return str;
  }
  return (BigInt(str) * BigInt(Math.pow(10, decimals))).toString();
}

/**
 * Jupiter Real Provider Implementation (Stage 9)
 * Interacts with Jupiter API v1 (api.jup.ag) with API key and Solana RPC via Helius.
 */
export const JupiterReal: JupiterAdapter = {
  /**
   * Fetch swap quote from Jupiter API
   */
  async getSwapQuote(params: JupiterSwapQuoteParams): Promise<JupiterSwapQuoteResult> {
    const { inputMint, outputMint, amount, slippageBps = 100 } = params;

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

        logger.info(`[JupiterReal] Requesting quote (attempt ${attempt}/3): ${inputMint} -> ${outputMint}, amount: ${atomicAmount}`);

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: getHeaders(),
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(`Jupiter quote error (${response.status}): ${errBody}`);
        }

        const data: any = await response.json();
        const outDecimals = resolveTokenDecimals(outputMint);
        const humanOutAmount = (Number(data.outAmount) / Math.pow(10, outDecimals)).toFixed(6);

        // Cache quote for buildSwapTransaction
        const cacheKey = `${inputMint}_${outputMint}_${atomicAmount}`;
        quoteCache.set(cacheKey, { quote: data, cachedAt: Date.now() });

        return {
          inputMint: data.inputMint,
          outputMint: data.outputMint,
          inAmount: amount,
          outAmount: humanOutAmount,
          priceImpactPct: parseFloat(data.priceImpactPct) || 0,
          route: data,
        };
      } catch (err: any) {
        lastError = err;
        logger.warn(`[JupiterReal] Quote attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 500));
        }
      }
    }

    throw new ProviderError(
      `Failed to get Jupiter swap quote after 3 attempts: ${lastError?.message}`,
      'jupiter-real'
    );
  },

  /**
   * Build serialized swap transaction from Jupiter API
   */
  async buildSwapTransaction(params: BuildSwapTxParams): Promise<BuildSwapTxResult> {
    const { sourceMint, destinationMint, amount, userPublicKey, slippageBps = 100 } = params;

    const inDecimals = resolveTokenDecimals(sourceMint);
    const atomicAmount = toSmallestUnits(amount, inDecimals);

    // Retrieve cached quote or fetch new one
    const cacheKey = `${sourceMint}_${destinationMint}_${atomicAmount}`;
    const cached = quoteCache.get(cacheKey);
    let quoteResponse: any;

    if (cached && Date.now() - cached.cachedAt < 25000) {
      quoteResponse = cached.quote;
    } else {
      const quoteRes = await this.getSwapQuote({
        inputMint: sourceMint,
        outputMint: destinationMint,
        amount,
        slippageBps,
      });
      quoteResponse = quoteRes.route;
    }

    let lastError: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const payload: any = {
          quoteResponse,
          userPublicKey: userPublicKey || process.env.FLUXPAY_WALLET_PUBLIC_KEY,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        };

        const response = await fetch(`${JUPITER_API_URL}/swap`, {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20000),
        });

        if (!response.ok) {
          const errBody = await response.text();
          throw new Error(`Jupiter swap build error (${response.status}): ${errBody}`);
        }

        const data: any = await response.json();
        if (!data.swapTransaction) {
          throw new Error('Jupiter did not return a swapTransaction in response');
        }

        return {
          serializedTransaction: data.swapTransaction,
        };
      } catch (err: any) {
        lastError = err;
        logger.warn(`[JupiterReal] Build swap attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 500));
        }
      }
    }

    throw new ProviderError(
      `Failed to build Jupiter swap transaction: ${lastError?.message}`,
      'jupiter-real'
    );
  },

  /**
   * Submit signed transaction to Solana RPC via Helius / failover
   */
  async submitSwap(signedTransaction: string): Promise<SubmitSwapResult> {
    let lastError: any = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const txBuffer = Buffer.from(signedTransaction, 'base64');
        const tx = VersionedTransaction.deserialize(txBuffer);

        const signature = await withFailover(async (connection) => {
          return await connection.sendTransaction(tx, {
            maxRetries: 3,
            skipPreflight: false,
          });
        });

        logger.info(`[JupiterReal] Transaction submitted with signature: ${signature}. Waiting for confirmation...`);

        // Wait for confirmation
        await withFailover(async (connection) => {
          const latestBlockhash = await connection.getLatestBlockhash('confirmed');
          const confirmation = await connection.confirmTransaction(
            {
              signature,
              blockhash: latestBlockhash.blockhash,
              lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            },
            'confirmed'
          );

          if (confirmation.value.err) {
            throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
          }
        });

        logger.info(`[JupiterReal] Transaction ${signature} confirmed successfully.`);
        return { txHash: signature };
      } catch (err: any) {
        lastError = err;
        logger.warn(`[JupiterReal] Submit swap attempt ${attempt} failed: ${err.message}`);

        // Only retry on network errors, not on permanent transaction failure
        const isNetworkError =
          err.name === 'FetchError' ||
          err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT' ||
          err.message?.includes('network') ||
          err.message?.includes('timeout');

        if (attempt < 3 && isNetworkError) {
          await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        } else {
          break;
        }
      }
    }

    throw new ProviderError(
      `Failed to submit swap to Solana network: ${lastError?.message}`,
      'solana-rpc'
    );
  },
};
