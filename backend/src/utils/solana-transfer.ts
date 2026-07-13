import { logger } from '../utils/logger';
/**
 * Solana Transfer Utilities — PRODUCTION (Non-Custodial)
 *
 * On-chain transfer functions for:
 * - Fee collection (FluxPay → fee wallet)
 * - Refunds (FluxPay hot wallet → customer)
 *
 * In non-custodial mode:
 * - No sweep function (funds go directly to merchant via Jupiter)
 * - No deposit wallet transfers
 * - FluxPay hot wallet only holds gas fees (0.1-1 SOL)
 * - Refunds are processed from FluxPay hot wallet
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { getConnection, getRecommendedPriorityFee, withFailover } from '../config/solana';
import { getTokenBySymbol, TOKEN_REGISTRY } from './token-registry';

// ─── Helper: Load FluxPay Wallet ────────────────────────────

/**
 * Load the FluxPay hot wallet from environment.
 * In non-custodial mode, this wallet only holds gas fees.
 */
function loadFluxPayWallet(): Keypair {
  const key = process.env.FLUXPAY_WALLET_PRIVATE_KEY;
  if (!key) {
    throw new Error('FLUXPAY_WALLET_PRIVATE_KEY is not configured');
  }

  // Support both hex and JSON array formats
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

// ─── Native SOL Transfer ────────────────────────────────────

/**
 * Transfer native SOL from one wallet to another.
 *
 * @param fromKeypair - Sender's keypair
 * @param toAddress - Recipient's public key (base58)
 * @param amountSol - Amount in SOL (human-readable, e.g. 1.5)
 * @returns Confirmed transaction signature
 */
async function transferSOL(
  fromKeypair: Keypair,
  toAddress: string,
  amountSol: number
): Promise<string> {
  const connection = getConnection();
  const toPubkey = new PublicKey(toAddress);
  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  // Get priority fee
  const priorityFee = await getRecommendedPriorityFee();

  const transaction = new Transaction();

  // Add priority fee instruction
  transaction.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFee,
    })
  );

  // Add transfer instruction
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey,
      lamports,
    })
  );

  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = fromKeypair.publicKey;

  // Sign and send
  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair], {
    commitment: 'confirmed',
    maxRetries: 3,
  });

  logger.info(
    `[Solana] SOL transfer confirmed: ${amountSol} SOL → ${toAddress.slice(0, 8)}... | tx: ${signature.slice(0, 12)}...`
  );

  return signature;
}

// ─── SPL Token Transfer ─────────────────────────────────────

/**
 * Transfer SPL tokens from one wallet to another.
 * Automatically creates the recipient's associated token account if it doesn't exist.
 *
 * @param fromKeypair - Sender's keypair
 * @param toAddress - Recipient's public key (base58)
 * @param amount - Amount in human-readable units (e.g. 100.5 USDC)
 * @param tokenSymbol - Token symbol (e.g. "USDC")
 * @returns Confirmed transaction signature
 */
async function transferSPLToken(
  fromKeypair: Keypair,
  toAddress: string,
  amount: number,
  tokenSymbol: string
): Promise<string> {
  const connection = getConnection();
  const toPubkey = new PublicKey(toAddress);

  // Resolve token info
  const tokenInfo = getTokenBySymbol(tokenSymbol);
  if (!tokenInfo) {
    throw new Error(`Unsupported token: ${tokenSymbol}`);
  }

  const mintPubkey = new PublicKey(tokenInfo.mintAddress);

  // Get or create the sender's associated token account
  const fromTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    fromKeypair,       // payer (pays for ATA creation if needed)
    mintPubkey,        // token mint
    fromKeypair.publicKey // owner
  );

  // Get or create the recipient's associated token account
  const toTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    fromKeypair,  // payer (sender pays for ATA creation)
    mintPubkey,   // token mint
    toPubkey      // owner (recipient)
  );

  // Convert human-readable amount to smallest unit
  const amountInSmallestUnit = BigInt(
    Math.floor(amount * Math.pow(10, tokenInfo.decimals))
  );

  // Get priority fee
  const priorityFee = await getRecommendedPriorityFee();

  const transaction = new Transaction();

  // Add priority fee
  transaction.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: priorityFee,
    })
  );

  // Add transfer instruction
  transaction.add(
    createTransferInstruction(
      fromTokenAccount.address,  // source ATA
      toTokenAccount.address,    // destination ATA
      fromKeypair.publicKey,     // owner of source
      amountInSmallestUnit,
      [],
      TOKEN_PROGRAM_ID
    )
  );

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = fromKeypair.publicKey;

  // Sign and send
  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair], {
    commitment: 'confirmed',
    maxRetries: 3,
  });

  logger.info(
    `[Solana] SPL transfer confirmed: ${amount} ${tokenSymbol} → ${toAddress.slice(0, 8)}... | tx: ${signature.slice(0, 12)}...`
  );

  return signature;
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Transfer tokens from FluxPay hot wallet to a merchant wallet (settlement).
 * In non-custodial mode, this is only used for optional fee collection.
 *
 * @param merchantAddress - Merchant's Solana wallet address
 * @param amount - Amount to transfer (human-readable)
 * @param token - Token symbol (SOL, USDC, etc.)
 * @returns Confirmed transaction signature
 */
export async function transferToMerchant(
  merchantAddress: string,
  amount: number,
  token: string
): Promise<string> {
  logger.info(
    `[Solana] Transfer: ${amount} ${token} → merchant ${merchantAddress.slice(0, 8)}...`
  );

  const fluxpayWallet = loadFluxPayWallet();

  return await withFailover(async () => {
    if (token.toUpperCase() === 'SOL') {
      return transferSOL(fluxpayWallet, merchantAddress, amount);
    }
    return transferSPLToken(fluxpayWallet, merchantAddress, amount, token);
  });
}

/**
 * Process a refund — send tokens from FluxPay hot wallet to the customer.
 * In non-custodial mode, refunds come from FluxPay's own funds
 * (since customer funds went directly to merchant).
 *
 * @param customerAddress - Customer's Solana wallet address
 * @param amount - Amount to refund (human-readable)
 * @param token - Token symbol
 * @returns Confirmed transaction signature
 */
export async function processRefundOnChain(
  customerAddress: string,
  amount: number,
  token: string
): Promise<string> {
  logger.info(
    `[Solana] Refund: ${amount} ${token} → customer ${customerAddress.slice(0, 8)}...`
  );

  // In non-custodial mode, refunds always come from FluxPay hot wallet
  const wallet = loadFluxPayWallet();

  return await withFailover(async () => {
    if (token.toUpperCase() === 'SOL') {
      return transferSOL(wallet, customerAddress, amount);
    }
    return transferSPLToken(wallet, customerAddress, amount, token);
  });
}
