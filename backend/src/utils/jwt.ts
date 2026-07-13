import jwt from 'jsonwebtoken';
import { MerchantPayload } from '../types/auth.types';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

/**
 * Generate a JWT token for a merchant
 */
export function generateToken(payload: MerchantPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token: string): MerchantPayload | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as MerchantPayload;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Calculate session expiry date (7 days from now)
 */
export function getSessionExpiry(): Date {
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 7);
  return expiry;
}
