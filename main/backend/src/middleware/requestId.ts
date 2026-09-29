import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';

export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const requestId = req.headers['x-request-id'] || randomUUID();
  req.headers['x-request-id'] = requestId;

  // Enhance logger with requestId
  const reqLogger = logger.child({ requestId });
  (req as any).logger = reqLogger;

  res.setHeader('X-Request-Id', requestId);
  next();
};
