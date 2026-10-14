import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me';

export interface ConsumerAuthPayload {
  id: string;
  role: string;
}

export interface ConsumerAuthRequest extends Request {
  user?: ConsumerAuthPayload;
}

/**
 * Middleware: requireConsumerAuth
 *
 * Verifies JWT token and enforces role === "consumer".
 * Completely isolated from merchant authentication.
 */
export function requireConsumerAuth(
  req: ConsumerAuthRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7).trim(); // Remove 'Bearer ' prefix
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const jwtSecret = process.env.JWT_SECRET || 'fallback-secret-change-me';
    const decoded = jwt.verify(token, jwtSecret) as jwt.JwtPayload;

    if (!decoded || typeof decoded !== 'object') {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Role check: must be explicitly "consumer"
    if (decoded.role !== 'consumer') {
      res.status(403).json({ error: 'Consumer access only' });
      return;
    }

    if (!decoded.id || typeof decoded.id !== 'string') {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Attach user { id, role } to request
    req.user = {
      id: decoded.id,
      role: decoded.role,
    };

    next();
  } catch (error: any) {
    if (error.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Session expired. Please sign in again' });
      return;
    }
    res.status(401).json({ error: 'Authentication required' });
  }
}
