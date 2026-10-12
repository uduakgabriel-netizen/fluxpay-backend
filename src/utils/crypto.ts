import { logger } from '../utils/logger';
import nacl from 'tweetnacl';
import { randomBytes } from 'crypto';

/**
 * Verify a Solana wallet signature
 *
 * @param message  - The plain-text message that was signed
 * @param signature - The signature as a base64 string
 * @param walletAddress - The Solana wallet public key (base58)
 * @returns true if the signature is valid
 */
export function verifyWalletSignature(
  message: string,
  signature: string,
  walletAddress: string
): boolean {
  try {
    // bs58 v5 is ESM-only, so we decode base58 manually using a buffer approach
    // We'll use the base58 alphabet to decode
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = Buffer.from(signature, 'base64');
    const publicKeyBytes = base58Decode(walletAddress);

    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch (error) {
    logger.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Generate a cryptographically secure random nonce
 */
export function generateNonce(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Base58 decode (Solana uses base58check / base58 bitcoin alphabet)
 */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [0];

  for (const char of str) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base58 character: ${char}`);
    }

    let carry = index;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Handle leading '1's (which represent leading zero bytes in base58)
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}
