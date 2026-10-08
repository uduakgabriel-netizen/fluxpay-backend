import jwt from 'jsonwebtoken';
import { MerchantPayload } from '../types/auth.types';

export const getJwtSecret = (): string => process.env.JWT_SECRET || 'fallback-secret-change-me';
export const getJwtExpiresIn = (): string => process.env.JWT_EXPIRES_IN || '7d';

/**
 * Generate a JWT token for a merchant
 */
export function generateToken(payload: MerchantPayload): string {
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: getJwtExpiresIn() as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Verify and decode a JWT token
 */
export function verifyToken(token: string): MerchantPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret()) as MerchantPayload;
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
