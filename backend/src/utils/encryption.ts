/**
 * Encryption Utility
 *
 * AES-256-GCM encryption/decryption for storing private keys securely.
 * Uses a master ENCRYPTION_KEY from environment variables.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128-bit IV for GCM
const AUTH_TAG_LENGTH = 16;

/**
 * Get the encryption key from environment.
 * Must be exactly 32 bytes (256 bits).
 */
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }

  // If key is hex-encoded (64 chars = 32 bytes)
  if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key)) {
    return Buffer.from(key, 'hex');
  }

  // If key is a plain string, pad/truncate to 32 bytes
  const keyBuffer = Buffer.alloc(32);
  Buffer.from(key, 'utf8').copy(keyBuffer);
  return keyBuffer;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * Output format: base64(iv + authTag + ciphertext)
 *
 * @param plaintext - The string to encrypt (e.g., a hex-encoded private key)
 * @returns Encrypted string in base64 format
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Combine: IV (16) + AuthTag (16) + Ciphertext
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString('base64');
}

/**
 * Decrypt a ciphertext that was encrypted with `encrypt()`.
 *
 * @param ciphertext - Base64-encoded string from encrypt()
 * @returns Decrypted plaintext string
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const combined = Buffer.from(ciphertext, 'base64');

  // Extract parts
  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Generate a random 32-byte encryption key (hex-encoded).
 * Use this to generate the ENCRYPTION_KEY for your .env file.
 */
export function generateEncryptionKey(): string {
  return randomBytes(32).toString('hex');
}
