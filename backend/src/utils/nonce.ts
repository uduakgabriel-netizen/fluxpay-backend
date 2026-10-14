import { randomBytes } from 'crypto';

/**
 * Reusable cryptographically secure random nonce generator
 * Generates 32 bytes hex-encoded string (64 characters)
 */
export function generateNonce(bytes: number = 32): string {
  return randomBytes(bytes).toString('hex');
}

export * from './consumerNonce';
