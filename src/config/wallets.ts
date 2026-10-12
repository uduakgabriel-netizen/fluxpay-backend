import { Keypair, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

/**
 * Wallets Configuration — Escrow & Gas Wallet Separation
 *
 * Security Principle:
 * - Gas Wallet: Holds only ~1 SOL for transaction/gas fees. Never holds customer or escrow funds.
 * - Escrow Wallet: Holds merchant USDC awaiting batch/fiat settlement.
 */

function parseKeypairFromString(keyStr: string): Keypair {
  const trimmed = keyStr.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    return Keypair.fromSecretKey(new Uint8Array(parsed));
  }
  if (trimmed.length > 80) {
    return Keypair.fromSecretKey(new Uint8Array(Buffer.from(trimmed, 'base64')));
  }
  return Keypair.fromSecretKey(new Uint8Array(Buffer.from(trimmed, 'hex')));
}

function loadKeypairFromFile(filename: string): Keypair | null {
  try {
    const candidates = [
      path.join(process.cwd(), filename),
      path.join(process.cwd(), 'backend', filename),
      path.join(__dirname, '../../', filename),
      path.join(__dirname, '../../../', filename),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        return parseKeypairFromString(raw);
      }
    }
  } catch (err: any) {
    logger.warn(`[Wallets] Failed to load keypair from ${filename}: ${err.message}`);
  }
  return null;
}

let _gasWallet: Keypair | null = null;
let _escrowWallet: Keypair | null = null;

/**
 * Returns the FluxPay Gas Wallet keypair (used ONLY to sign for and pay gas fees)
 */
export function getGasWalletKeypair(): Keypair {
  if (_gasWallet) return _gasWallet;

  const keyEnv =
    process.env.FLUXPAY_GAS_WALLET_PRIVATE_KEY_BASE64 ||
    process.env.FLUXPAY_WALLET_PRIVATE_KEY_BASE64 ||
    process.env.FLUXPAY_WALLET_PRIVATE_KEY;

  if (keyEnv) {
    try {
      _gasWallet = parseKeypairFromString(keyEnv);
      return _gasWallet;
    } catch (err: any) {
      logger.error(`[Wallets] Failed to parse Gas Wallet from ENV: ${err.message}`);
    }
  }

  // Fallback to fluxpay-wallet.json
  const fromFile = loadKeypairFromFile('fluxpay-wallet.json');
  if (fromFile) {
    _gasWallet = fromFile;
    return _gasWallet;
  }

  throw new Error('FLUXPAY_GAS_WALLET_PRIVATE_KEY_BASE64 or fluxpay-wallet.json is not configured');
}

/**
 * Returns the public key of the Gas Wallet
 */
export function getGasWalletPublicKey(): PublicKey {
  const configured =
    process.env.FLUXPAY_GAS_WALLET_PUBLIC_KEY ||
    process.env.FLUXPAY_WALLET_PUBLIC_KEY;
  if (configured) {
    return new PublicKey(configured);
  }
  return getGasWalletKeypair().publicKey;
}

/**
 * Returns the FluxPay Escrow Wallet keypair (holds merchant USDC awaiting fiat settlement)
 */
export function getEscrowWalletKeypair(): Keypair {
  if (_escrowWallet) return _escrowWallet;

  const keyEnv = process.env.FLUXPAY_ESCROW_WALLET_PRIVATE_KEY_BASE64;
  if (keyEnv) {
    try {
      _escrowWallet = parseKeypairFromString(keyEnv);
      return _escrowWallet;
    } catch (err: any) {
      logger.error(`[Wallets] Failed to parse Escrow Wallet from ENV: ${err.message}`);
    }
  }

  // Fallback to fluxpay-escrow-wallet.json
  const fromFile = loadKeypairFromFile('fluxpay-escrow-wallet.json');
  if (fromFile) {
    _escrowWallet = fromFile;
    return _escrowWallet;
  }

  throw new Error('FLUXPAY_ESCROW_WALLET_PRIVATE_KEY_BASE64 or fluxpay-escrow-wallet.json is not configured');
}

/**
 * Returns the public key of the Escrow Wallet
 */
export function getEscrowWalletPublicKey(): PublicKey {
  const configured = process.env.FLUXPAY_ESCROW_WALLET_PUBLIC_KEY;
  if (configured) {
    return new PublicKey(configured);
  }
  return getEscrowWalletKeypair().publicKey;
}
