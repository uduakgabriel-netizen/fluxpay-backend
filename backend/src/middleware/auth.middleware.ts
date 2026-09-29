import { logger } from '../utils/logger';
import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { verifyToken } from '../utils/jwt';
import { AuthRequest } from '../types/auth.types';

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

    const token = authHeader.replace('Bearer ', '');

    // Verify JWT
    const decoded = verifyToken(token);
    if (!decoded) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    // Check session exists in database and is not expired
    const session = await prisma.session.findUnique({
      where: { token },
      include: { merchant: true },
    });

    if (!session) {
      res.status(401).json({ error: 'Session not found. Please log in again.' });
      return;
    }

    if (new Date() > session.expiresAt) {
      // Clean up expired session
      await prisma.session.delete({ where: { id: session.id } });
      res.status(401).json({ error: 'Session expired. Please log in again.' });
      return;
    }

    // Attach merchant info to request
    req.merchant = {
      id: session.merchant.id,
      walletAddress: session.merchant.walletAddress,
      email: session.merchant.email,
      businessName: session.merchant.businessName,
    };

    next();
  } catch (error) {
    logger.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
