import { randomBytes } from 'crypto';
import nacl from 'tweetnacl';

// Base58 alphabet (Bitcoin/Solana)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Generate a new Solana keypair for a payment receiving address
 * Returns the public address (base58) and encrypted private key
 */
export function generateReceivingAddress(): {
  address: string;
  privateKey: string;
} {
  // Generate a new Ed25519 keypair using tweetnacl
  const keypair = nacl.sign.keyPair();

  const address = base58Encode(keypair.publicKey);
  // Store private key as hex (should be encrypted in production)
  const privateKey = Buffer.from(keypair.secretKey).toString('hex');

  return { address, privateKey };
}

/**
 * Supported SPL tokens for Stage 2
 */
export const SUPPORTED_TOKENS = [
  'SOL',
  'USDC',
  'USDT',
  'JUP',
  'BONK',
  'mSOL',
  'COPE',
  'DUST',
  'SBR',
  'MN',
] as const;

export type SupportedToken = (typeof SUPPORTED_TOKENS)[number];

/**
 * Check if a token is supported
 */
export function isTokenSupported(token: string): boolean {
  return SUPPORTED_TOKENS.includes(token.toUpperCase() as SupportedToken);
}

/**
 * Base58 encode
 */
function base58Encode(bytes: Uint8Array): string {
  // Convert bytes to a big integer
  let num = BigInt(0);
  for (const byte of bytes) {
    num = num * BigInt(256) + BigInt(byte);
  }

  // Encode
  let encoded = '';
  while (num > BigInt(0)) {
    const remainder = Number(num % BigInt(58));
    num = num / BigInt(58);
    encoded = BASE58_ALPHABET[remainder] + encoded;
  }

  // Handle leading zeros
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = '1' + encoded;
  }

  return encoded;
}
