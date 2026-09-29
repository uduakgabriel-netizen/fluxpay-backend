/**
 * Secret Generation & Verification Utility
 *
 * Generates API keys and webhook secrets with secure hashing.
 * Never stores plaintext — only SHA256 hashes are persisted.
 * Uses timing-safe comparison to prevent timing attacks.
 */

import { randomBytes, createHash, timingSafeEqual } from 'crypto';

// ─── API Key Generation ─────────────────────────────────────

export interface GeneratedApiKey {
  /** Full plaintext key — show ONCE to merchant, never store */
  fullKey: string;
  /** Key prefix for identification (e.g., "fluxpay_live_") */
  prefix: string;
  /** SHA256 hash of the full key — this is what gets stored */
  keyHash: string;
  /** Last 4 characters for display in dashboard */
  lastChars: string;
}

/**
 * Generate a new API key in format: fluxpay_live_{random_base64url}
 * Returns the full key (show once), hash (store in DB), prefix, and last 4 chars.
 */
export function generateApiKey(mode: 'live' | 'test' = 'live'): GeneratedApiKey {
  const prefix = `sk_${mode}_`;
  const randomPart = randomBytes(32).toString('base64url');
  const fullKey = `${prefix}${randomPart}`;

  return {
    fullKey,
    prefix,
    keyHash: hashSecret(fullKey),
    lastChars: fullKey.slice(-4),
  };
}

// ─── Webhook Secret Generation ──────────────────────────────

export interface GeneratedWebhookSecret {
  /** Full plaintext secret — show ONCE to merchant, never store */
  fullSecret: string;
  /** Secret prefix for identification */
  prefix: string;
  /** SHA256 hash of the full secret — this is what gets stored */
  secretHash: string;
  /** Last 4 characters for display in dashboard */
  lastChars: string;
}

/**
 * Generate a new webhook secret in format: whsec_{random_hex}
 * Returns the full secret (show once), hash (store in DB), prefix, and last 4 chars.
 */
export function generateWebhookSecretKey(): GeneratedWebhookSecret {
  const prefix = 'whsec_';
  const randomPart = randomBytes(24).toString('hex');
  const fullSecret = `${prefix}${randomPart}`;

  return {
    fullSecret,
    prefix,
    secretHash: hashSecret(fullSecret),
    lastChars: fullSecret.slice(-4),
  };
}

// ─── Hashing & Verification ────────────────────────────────

/**
 * Hash a secret using SHA256
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Verify a provided secret against a stored hash using timing-safe comparison.
 * Prevents timing attacks by ensuring comparison takes constant time.
 */
export function verifySecret(providedSecret: string, storedHash: string): boolean {
  const providedHash = hashSecret(providedSecret);

  // Both hashes are hex strings of same length (64 chars for SHA256)
  if (providedHash.length !== storedHash.length) {
    return false;
  }

  const a = Buffer.from(providedHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');

  return timingSafeEqual(a, b);
}

// ─── Webhook Signature Generation ───────────────────────────

import { createHmac } from 'crypto';

/**
 * Generate HMAC-SHA256 webhook signature in Stripe-style format:
 * X-FluxPay-Signature: t={timestamp},v1={signature}
 *
 * The signature is computed over: {timestamp}.{payload}
 */
export function generateWebhookSignature(
  payload: string,
  secret: string,
  timestamp?: number
): { signature: string; timestamp: number } {
  const ts = timestamp || Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${payload}`;
  const hmac = createHmac('sha256', secret).update(signedPayload).digest('hex');

  return {
    signature: `t=${ts},v1=${hmac}`,
    timestamp: ts,
  };
}

/**
 * Verify a webhook signature from the X-FluxPay-Signature header.
 * Merchants use this to verify incoming webhooks are from FluxPay.
 */
export function verifyWebhookSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = 300 // 5 minutes
): boolean {
  // Parse header: t={timestamp},v1={signature}
  const parts: Record<string, string> = {};
  for (const part of signatureHeader.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key && value) {
      parts[key.trim()] = value.trim();
    }
  }

  const timestamp = parseInt(parts['t'], 10);
  const expectedSig = parts['v1'];

  if (!timestamp || !expectedSig) {
    return false;
  }

  // Check timestamp tolerance
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return false;
  }

  // Compute expected signature
  const signedPayload = `${timestamp}.${payload}`;
  const computedSig = createHmac('sha256', secret).update(signedPayload).digest('hex');

  // Timing-safe comparison
  if (computedSig.length !== expectedSig.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(computedSig, 'hex'), Buffer.from(expectedSig, 'hex'));
}
