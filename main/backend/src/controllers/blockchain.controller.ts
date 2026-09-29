import { logger } from '../utils/logger';
/**
 * Blockchain Controller
 *
 * API endpoints for blockchain-related operations:
 * - Check wallet balances
 * - Verify transactions
 * - Get swap quotes
 * - Get supported tokens
 * - Get SOL buffer for fee reservation
 */

import { Request, Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import { getWalletBalance, verifyTransaction } from '../services/solana-wallet.service';
import { getSwapQuote } from '../services/jupiter.service';
import { TOKEN_REGISTRY, getAllTokenSymbols, getTokenBySymbol } from '../utils/token-registry';
import { calculateSolBuffer, getMaxSwapAmountSol, hasEnoughSolForFees } from '../utils/sol-buffer';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getConnection } from '../config/solana';

/**
 * GET /api/blockchain/tokens
 * Get list of all supported tokens
 */
export async function getSupportedTokens(req: Request, res: Response): Promise<void> {
  const tokens = Object.values(TOKEN_REGISTRY).map((t) => ({
    symbol: t.symbol,
    name: t.name,
    mintAddress: t.mintAddress,
    decimals: t.decimals,
    isNative: t.isNative,
  }));

  res.status(200).json({ tokens });
}

/**
 * GET /api/blockchain/balance/:address
 * Get wallet balance for a Solana address
 */
export async function getBalance(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { address } = req.params;

    if (!address || address.length < 32) {
      res.status(400).json({ error: 'Invalid Solana address' });
      return;
    }

    const balance = await getWalletBalance(address);
    res.status(200).json(balance);
  } catch (error: any) {
    logger.error('[Blockchain] Balance check error:', error);
    res.status(500).json({ error: 'Failed to check wallet balance' });
  }
}

/**
 * GET /api/blockchain/transaction/:signature
 * Verify and get details of a Solana transaction
 */
export async function getTransaction(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { signature } = req.params;

    if (!signature || signature.length < 32) {
      res.status(400).json({ error: 'Invalid transaction signature' });
      return;
    }

    const tx = await verifyTransaction(signature);

    if (!tx) {
      res.status(404).json({ error: 'Transaction not found or has errors' });
      return;
    }

    res.status(200).json(tx);
  } catch (error: any) {
    logger.error('[Blockchain] Transaction verification error:', error);
    res.status(500).json({ error: 'Failed to verify transaction' });
  }
}

/**
 * GET /api/blockchain/swap-quote
 * Get a Jupiter swap quote using ExactOut mode.
 * The `amount` parameter is the exact output amount the merchant wants to receive.
 * Jupiter calculates how much input the buyer must send.
 * Query params: from (buyer's token), to (merchant's token), amount (desired output)
 */
export async function getQuote(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { from, to, amount } = req.query;

    if (!from || !to || !amount) {
      res.status(400).json({ error: 'Missing required params: from, to, amount' });
      return;
    }

    const fromToken = getTokenBySymbol(from as string);
    const toToken = getTokenBySymbol(to as string);

    if (!fromToken) {
      res.status(400).json({ error: `Unsupported source token: ${from}` });
      return;
    }

    if (!toToken) {
      res.status(400).json({ error: `Unsupported destination token: ${to}` });
      return;
    }

    const amountNum = parseFloat(amount as string);
    if (isNaN(amountNum) || amountNum <= 0) {
      res.status(400).json({ error: 'Amount must be a positive number' });
      return;
    }

    // ExactOut: amountNum is what the merchant wants to RECEIVE
    const quote = await getSwapQuote(from as string, to as string, amountNum);

    if (!quote) {
      res.status(404).json({ error: 'No swap route available' });
      return;
    }

    // In ExactOut mode:
    //   - inAmount = variable (what the buyer must send)
    //   - outAmount = fixed (what the merchant receives, matches requested amount)
    const requiredInput = Number(quote.inAmount) / Math.pow(10, fromToken.decimals);
    const guaranteedOutput = Number(quote.outAmount) / Math.pow(10, toToken.decimals);

    // Include SOL buffer info so frontend knows how much SOL to reserve for fees
    const buffer = await calculateSolBuffer();

    res.status(200).json({
      from: fromToken.symbol,
      to: toToken.symbol,
      requestedOutput: amountNum,
      requiredInput,
      guaranteedOutput,
      priceImpact: quote.priceImpactPct,
      slippageBps: quote.slippageBps,
      swapMode: 'ExactOut',
      estimatedFee: quote.estimatedFeeInSol,
      solBuffer: {
        totalBufferSol: buffer.totalBufferSol,
        rentExemptionSol: buffer.rentExemptionSol,
        networkFeeSol: buffer.networkFeeSol,
        priorityFeeSol: buffer.priorityFeeSol,
      },
    });
  } catch (error: any) {
    logger.error('[Blockchain] Swap quote error:', error);
    res.status(500).json({ error: 'Failed to get swap quote' });
  }
}

/**
 * GET /api/blockchain/sol-buffer
 * Get the current SOL buffer required for swap transactions.
 *
 * Optional query param: walletAddress — if provided, also returns
 * the max swappable SOL amount and whether the wallet has enough for fees.
 */
export async function getSolBuffer(req: Request, res: Response): Promise<void> {
  try {
    const { walletAddress } = req.query;
    const buffer = await calculateSolBuffer();

    const response: any = {
      buffer: {
        totalBufferSol: buffer.totalBufferSol,
        totalBufferLamports: buffer.totalBufferLamports,
        rentExemptionSol: buffer.rentExemptionSol,
        networkFeeSol: buffer.networkFeeSol,
        priorityFeeSol: buffer.priorityFeeSol,
        safetyMarginSol: buffer.safetyMarginSol,
      },
      description: 'SOL reserved for transaction fees. This is NOT an extra charge — it stays in the customer wallet.',
    };

    // If a wallet address was provided, also check its balance
    if (walletAddress && typeof walletAddress === 'string' && walletAddress.length >= 32) {
      try {
        const connection = getConnection();
        const pubkey = new PublicKey(walletAddress);
        const balanceLamports = await connection.getBalance(pubkey);
        const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

        const { maxSwapAmountSol, sufficient } = await getMaxSwapAmountSol(balanceLamports);
        const feeCheck = await hasEnoughSolForFees(balanceLamports);

        response.wallet = {
          address: walletAddress,
          balanceSol,
          balanceLamports,
          maxSwapAmountSol,
          hasSufficientSolForFees: feeCheck.sufficient,
          shortfallSol: feeCheck.shortfall,
        };
      } catch (walletErr: any) {
        response.wallet = {
          address: walletAddress,
          error: `Failed to check wallet: ${walletErr.message}`,
        };
      }
    }

    res.status(200).json(response);
  } catch (error: any) {
    logger.error('[Blockchain] SOL buffer calculation error:', error);
    res.status(500).json({ error: 'Failed to calculate SOL buffer' });
  }
}

/**
 * GET /api/blockchain/network
 * Get current network configuration
 */
export async function getNetworkInfo(req: Request, res: Response): Promise<void> {
  const network = process.env.SOLANA_NETWORK || 'devnet';
  const rpcUrl = network === 'mainnet'
    ? process.env.SOLANA_RPC_URL
    : process.env.SOLANA_RPC_DEVNET;

  res.status(200).json({
    network,
    rpcUrl: rpcUrl ? rpcUrl.replace(/\/\/.*@/, '//***@') : 'not configured', // Hide credentials
    fluxpayWallet: process.env.FLUXPAY_WALLET_PUBLIC_KEY || 'not configured',
    heliusConfigured: !!process.env.HELIUS_API_KEY,
    jupiterApiUrl: process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v2',
    supportedTokens: getAllTokenSymbols(),
  });
}
