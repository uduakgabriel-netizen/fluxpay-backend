import { logger } from '../utils/logger';
/**
 * Solana Wallet Service — PRODUCTION
 *
 * Manages Solana wallets for payment receiving addresses:
 * - Generate new keypairs for each payment
 * - Encrypt/store private keys securely
 * - Check wallet balances via Solana RPC (@solana/web3.js)
 * - Verify transaction signatures on-chain
 */

import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { encrypt, decrypt } from '../utils/encryption';
import { TOKEN_REGISTRY, getTokenByMint } from '../utils/token-registry';
import { getConnection, withFailover } from '../config/solana';

// ─── Wallet Generation ──────────────────────────────────────

export interface GeneratedWallet {
  address: string;
  encryptedPrivateKey: string;
}

/**
 * Generate a new Solana keypair for a payment receiving address.
 * The private key is encrypted before returning.
 */
export function generateReceivingWallet(): GeneratedWallet {
  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();
  const privateKeyHex = Buffer.from(keypair.secretKey).toString('hex');
  const encryptedPrivateKey = encrypt(privateKeyHex);

  return { address, encryptedPrivateKey };
}

/**
 * Restore a Keypair from an encrypted private key
 */
export function restoreKeypair(encryptedPrivateKey: string): Keypair {
  const privateKeyHex = decrypt(encryptedPrivateKey);
  const secretKey = new Uint8Array(Buffer.from(privateKeyHex, 'hex'));
  return Keypair.fromSecretKey(secretKey);
}

// ─── Balance Checking ───────────────────────────────────────

export interface WalletBalance {
  sol: number;
  tokens: Array<{
    symbol: string;
    mintAddress: string;
    amount: number;
    decimals: number;
  }>;
}

/**
 * Get the SOL balance and SPL token balances for a wallet
 * Uses real @solana/web3.js RPC calls with failover.
 */
export async function getWalletBalance(address: string): Promise<WalletBalance> {
  return await withFailover(async (connection) => {
    const pubkey = new PublicKey(address);

    // Get SOL balance
    const solBalanceLamports = await connection.getBalance(pubkey);
    const solBalance = solBalanceLamports / LAMPORTS_PER_SOL;

    // Get all token accounts
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
      programId: TOKEN_PROGRAM_ID,
    });

    const tokens: WalletBalance['tokens'] = [];

    for (const { account } of tokenAccounts.value) {
      const parsed = account.data.parsed?.info;
      if (!parsed) continue;

      const mintAddress = parsed.mint;
      const tokenInfo = getTokenByMint(mintAddress);
      const amount = parsed.tokenAmount?.uiAmount ?? 0;
      const decimals = parsed.tokenAmount?.decimals ?? 0;

      tokens.push({
        symbol: tokenInfo?.symbol || 'UNKNOWN',
        mintAddress,
        amount,
        decimals,
      });
    }

    return { sol: solBalance, tokens };
  });
}

// ─── Transaction Verification ───────────────────────────────

export interface TransactionDetails {
  signature: string;
  sender: string;
  receiver: string;
  amount: number;
  token: string;
  mintAddress: string;
  confirmed: boolean;
  slot: number;
  blockTime: number | null;
  fee: number;
}

/**
 * Verify a transaction on the Solana blockchain using real RPC.
 * Returns parsed transaction details if valid.
 */
export async function verifyTransaction(signature: string): Promise<TransactionDetails | null> {
  try {
    return await withFailover(async (connection) => {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!tx) return null;

      const meta = tx.meta;
      if (meta?.err) {
        logger.info(`[Solana] Transaction ${signature.slice(0, 12)}... has error:`, meta.err);
        return null;
      }

      // Parse the transaction to extract transfer details
      const instructions = tx.transaction?.message?.instructions || [];
      let sender = '';
      let receiver = '';
      let amount = 0;
      let tokenSymbol = 'SOL';
      let mintAddress = TOKEN_REGISTRY.SOL.mintAddress;

      for (const ix of instructions) {
        const parsed = (ix as any).parsed;
        const program = (ix as any).program;

        // Native SOL transfer
        if (program === 'system' && parsed?.type === 'transfer') {
          sender = parsed.info.source;
          receiver = parsed.info.destination;
          amount = parsed.info.lamports / LAMPORTS_PER_SOL;
          tokenSymbol = 'SOL';
          mintAddress = TOKEN_REGISTRY.SOL.mintAddress;
          break;
        }

        // SPL Token transfer
        if (program === 'spl-token' && (parsed?.type === 'transfer' || parsed?.type === 'transferChecked')) {
          sender = parsed.info.authority || parsed.info.source;
          receiver = parsed.info.destination;
          const mint = parsed.info.mint;
          mintAddress = mint || TOKEN_REGISTRY.SOL.mintAddress;

          if (parsed.type === 'transferChecked') {
            amount = parsed.info.tokenAmount?.uiAmount ?? 0;
          } else {
            const tokenInfo = getTokenByMint(mintAddress);
            const decimals = tokenInfo?.decimals || 6;
            amount = Number(parsed.info.amount) / Math.pow(10, decimals);
          }

          const token = getTokenByMint(mintAddress);
          tokenSymbol = token?.symbol || 'UNKNOWN';
          break;
        }
      }

      // Also check inner instructions
      if (!sender && meta?.innerInstructions) {
        for (const inner of meta.innerInstructions) {
          for (const ix of inner.instructions) {
            const parsed = (ix as any).parsed;
            const program = (ix as any).program;
            if (program === 'system' && parsed?.type === 'transfer') {
              sender = parsed.info.source;
              receiver = parsed.info.destination;
              amount = parsed.info.lamports / LAMPORTS_PER_SOL;
              tokenSymbol = 'SOL';
              break;
            }
          }
          if (sender) break;
        }
      }

      return {
        signature,
        sender,
        receiver,
        amount,
        token: tokenSymbol,
        mintAddress,
        confirmed: true,
        slot: tx.slot,
        blockTime: tx.blockTime ?? null,
        fee: (meta?.fee || 0) / LAMPORTS_PER_SOL,
      };
    });
  } catch (error) {
    logger.error(`[Solana] Error verifying tx ${signature}:`, error);
    return null;
  }
}
