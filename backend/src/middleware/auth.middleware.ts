import { logger } from '../utils/logger';
import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { verifyToken } from '../utils/jwt';
import { AuthRequest } from '../types/auth.types';
import { memorySessions } from '../services/auth.service';

const prisma = new PrismaClient();

/**
 * Authentication middleware
 * Verifies JWT token from Authorization header and attaches merchant to request
 */
export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const token = authHeader.replace('Bearer ', '').trim();

    // Verify JWT cryptographically
    const decoded: any = verifyToken(token);
    if (!decoded) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    // Role MUST be merchant (reject unverified, consumer, or invalid roles)
    const role = decoded.role || (decoded.id && !decoded.consumerId ? 'merchant' : null);
    if (role !== 'merchant' || decoded.role === 'consumer') {
      res.status(401).json({ error: 'Unauthorized: Merchant role required' });
      return;
    }

    // Check session exists in database (with memory fallback)
    let session: any = null;
    try {
      session = await prisma.session.findUnique({
        where: { token },
        include: { merchant: true },
      });
    } catch (dbErr: any) {
      logger.warn(`[AuthMiddleware] DB session lookup failed, using memory: ${dbErr.message}`);
    }

    if (!session) {
      session = memorySessions.get(token);
    }

    if (session) {
      if (new Date() > new Date(session.expiresAt)) {
        try {
          if (session.id) {
            await prisma.session.delete({ where: { id: session.id } });
          }
        } catch {}
        memorySessions.delete(token);
        res.status(401).json({ error: 'Session expired. Please log in again.' });
        return;
      }

      req.merchant = {
        id: session.merchant?.id || session.merchantId || decoded.id,
        walletAddress: session.merchant?.walletAddress || decoded.walletAddress || '',
        email: session.merchant?.email || decoded.email || null,
        businessName: session.merchant?.businessName || decoded.businessName || 'Merchant',
      };
      return next();
    }

    // Cryptographic fallback: if JWT is signed and valid with JWT_SECRET, trust the payload
    if (decoded && (decoded.id || decoded.sub)) {
      req.merchant = {
        id: decoded.id || decoded.sub,
        walletAddress: decoded.walletAddress || '',
        email: decoded.email || null,
        businessName: decoded.businessName || 'Merchant',
      };
      return next();
    }

    res.status(401).json({ error: 'Session not found. Please log in again.' });
  } catch (error) {
    logger.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
