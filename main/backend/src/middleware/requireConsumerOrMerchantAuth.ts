import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const getJwtSecret = () => process.env.JWT_SECRET || 'fallback-secret-change-me';

export interface AuthenticatedActor {
  type: 'consumer' | 'merchant';
  id: string;
}

export interface AuthContextRequest extends Request {
  actor?: AuthenticatedActor;
  user?: {
    id: string;
    role: string;
  };
  merchant?: {
    id: string;
    walletAddress?: string;
    email?: string | null;
    businessName?: string;
  };
}

/**
 * Middleware: requireConsumerOrMerchantAuth
 * Enforces valid authentication from either a consumer (role === "consumer")
 * or a merchant.
 */
export function requireConsumerOrMerchantAuth(
  req: AuthContextRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const jwtSecret = process.env.JWT_SECRET || 'fallback-secret-change-me';
    const decoded = jwt.verify(token, jwtSecret) as any;

    if (!decoded || typeof decoded !== 'object' || !decoded.id) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (decoded.role === 'consumer') {
      req.actor = { type: 'consumer', id: decoded.id };
      req.user = { id: decoded.id, role: 'consumer' };
    } else {
      req.actor = { type: 'merchant', id: decoded.id };
      req.merchant = {
        id: decoded.id,
        walletAddress: decoded.walletAddress,
        email: decoded.email,
        businessName: decoded.businessName,
      };
    }

    next();
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Session expired. Please sign in again' });
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
  }
}

/**
 * Optional Auth: Attaches actor if valid token present, allows through if no token.
 */
export function optionalConsumerOrMerchantAuth(
  req: AuthContextRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as any;

    if (decoded && typeof decoded === 'object' && decoded.id) {
      if (decoded.role === 'consumer') {
        req.actor = { type: 'consumer', id: decoded.id };
        req.user = { id: decoded.id, role: 'consumer' };
      } else {
        req.actor = { type: 'merchant', id: decoded.id };
        req.merchant = {
          id: decoded.id,
          walletAddress: decoded.walletAddress,
          email: decoded.email,
          businessName: decoded.businessName,
        };
      }
    }
    next();
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Session expired. Please sign in again' });
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
  }
}
