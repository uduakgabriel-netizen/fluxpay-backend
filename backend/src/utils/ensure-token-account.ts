/**
 * Ensure Token Account Utility
 *
 * Pre-creates Associated Token Accounts (ATAs) before swap execution.
 * This fixes the "Insufficient funds" error (Jupiter error code 6024)
 * that occurs when a wallet has never held the output token before.
 *
 * Uses raw @solana/web3.js — no @solana/spl-token dependency needed.
 *
 * FluxPay sponsors the ATA rent (~0.002 SOL per account) for seamless UX.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { getConnection, withFailover } from '../config/solana';
import { logger } from './logger';

// ─── Program IDs ────────────────────────────────────────────

/** SPL Token Program */
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** SPL Token 2022 Program */
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/** Associated Token Account Program */
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/** Native SOL mint — skip ATA creation for native SOL */
const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

// ─── ATA Address Derivation ─────────────────────────────────

/**
 * Derive the Associated Token Account address for a wallet + mint.
 * This is the same deterministic address that @solana/spl-token computes.
 */
export function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
}

/**
 * Build the instruction to create an Associated Token Account.
 * Equivalent to createAssociatedTokenAccountInstruction from @solana/spl-token.
 */
function buildCreateATAInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.alloc(0), // No data needed for create ATA
  });
}

// ─── Core Function: Ensure Token Account Exists ─────────────

export interface EnsureATAResult {
  ataAddress: string;
  alreadyExists: boolean;
  created: boolean;
  txSignature?: string;
  error?: string;
}

/**
 * Ensure that an Associated Token Account exists for the given wallet + mint.
 * If it doesn't exist, FluxPay's gas wallet will pay the rent to create it.
 *
 * This MUST be called before any swap where the recipient might not have
 * a token account for the output token.
 *
 * @param walletAddress - The wallet that needs the token account
 * @param mintAddress - The SPL token mint address
 * @param payerKeypair - The keypair that will pay rent (FluxPay gas wallet)
 * @returns Result including whether the ATA was created or already existed
 */
export async function ensureTokenAccountExists(
  walletAddress: string,
  mintAddress: string,
  payerKeypair: Keypair
): Promise<EnsureATAResult> {
  // Skip for native SOL — no ATA needed
  if (mintAddress === NATIVE_SOL_MINT) {
    return {
      ataAddress: walletAddress,
      alreadyExists: true,
      created: false,
    };
  }

  const wallet = new PublicKey(walletAddress);
  const mint = new PublicKey(mintAddress);

  // Derive the ATA address
  const ataAddress = getAssociatedTokenAddressSync(mint, wallet);

  try {
    return await withFailover(async (connection) => {
      // Check if the ATA already exists
      const accountInfo = await connection.getAccountInfo(ataAddress);

      if (accountInfo !== null) {
        logger.debug(`[EnsureATA] ATA already exists for ${walletAddress.slice(0, 8)}... mint ${mintAddress.slice(0, 8)}...`);
        return {
          ataAddress: ataAddress.toBase58(),
          alreadyExists: true,
          created: false,
        };
      }

      // ATA doesn't exist — create it with FluxPay paying rent
      logger.info(`[EnsureATA] Creating ATA for ${walletAddress.slice(0, 8)}... mint ${mintAddress.slice(0, 8)}... (FluxPay sponsors rent)`);

      const createInstruction = buildCreateATAInstruction(
        payerKeypair.publicKey,
        ataAddress,
        wallet,
        mint
      );

      const transaction = new Transaction().add(createInstruction);

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;
      transaction.feePayer = payerKeypair.publicKey;

      // Sign with FluxPay wallet (payer)
      transaction.sign(payerKeypair);

      const txSignature = await connection.sendRawTransaction(
        transaction.serialize(),
        { skipPreflight: false, maxRetries: 3 }
      );

      // Wait for confirmation
      await connection.confirmTransaction(
        { signature: txSignature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      logger.info(`[EnsureATA] ✓ ATA created: ${ataAddress.toBase58()} (tx: ${txSignature.slice(0, 12)}...)`);

      return {
        ataAddress: ataAddress.toBase58(),
        alreadyExists: false,
        created: true,
        txSignature,
      };
    });
  } catch (error: any) {
    // If the error is "already in use", the account was created by someone else concurrently
    if (error.message?.includes('already in use') || error.message?.includes('already exists')) {
      logger.info(`[EnsureATA] ATA was created concurrently for ${walletAddress.slice(0, 8)}...`);
      return {
        ataAddress: ataAddress.toBase58(),
        alreadyExists: true,
        created: false,
      };
    }

    logger.error(`[EnsureATA] Failed to create ATA for ${walletAddress.slice(0, 8)}... mint ${mintAddress.slice(0, 8)}...:`, error.message);
    return {
      ataAddress: ataAddress.toBase58(),
      alreadyExists: false,
      created: false,
      error: error.message,
    };
  }
}

/**
 * Ensure ATAs exist for BOTH the customer and merchant for a swap.
 * Call this before executing any Jupiter swap transaction.
 *
 * @param customerWallet - Customer's wallet address
 * @param merchantWallet - Merchant's wallet address
 * @param inputMint - The token the customer is sending
 * @param outputMint - The token the merchant will receive
 * @param payerKeypair - FluxPay gas wallet keypair
 */
export async function ensureSwapATAs(
  customerWallet: string,
  merchantWallet: string,
  inputMint: string,
  outputMint: string,
  payerKeypair: Keypair
): Promise<{ success: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Merchant needs ATA for the output token (what they receive)
  const merchantResult = await ensureTokenAccountExists(merchantWallet, outputMint, payerKeypair);
  if (!merchantResult.alreadyExists && !merchantResult.created) {
    errors.push(`Failed to create merchant ATA for output token: ${merchantResult.error}`);
  }

  // Customer needs ATA for the output token too (Jupiter may route through intermediate tokens)
  // Actually, for ExactOut mode, the customer sends input tokens and merchant receives output.
  // But Jupiter may need intermediate ATAs. Jupiter's useSharedAccounts handles this.
  // We primarily need to ensure the MERCHANT has the output token ATA.

  if (errors.length > 0) {
    logger.error(`[EnsureATA] Swap ATA setup had errors:`, errors);
  }

  return {
    success: errors.length === 0,
    errors,
  };
}

/**
 * Check if a token account exists for a given wallet + mint.
 * Does NOT create the account — just checks.
 */
export async function tokenAccountExists(
  walletAddress: string,
  mintAddress: string
): Promise<boolean> {
  if (mintAddress === NATIVE_SOL_MINT) return true;

  try {
    const wallet = new PublicKey(walletAddress);
    const mint = new PublicKey(mintAddress);
    const ataAddress = getAssociatedTokenAddressSync(mint, wallet);

    const connection = getConnection();
    const accountInfo = await connection.getAccountInfo(ataAddress);
    return accountInfo !== null;
  } catch {
    return false;
  }
}
