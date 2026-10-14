import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError';
import { logger } from '../utils/logger';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Log every error with full context
  logger.error({
    message: err.message,
    name: err.name,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: (req as any).user?.id || (req as any).actor?.id || (req as any).merchant?.id,
    body: req.body,
    timestamp: new Date().toISOString()
  });

  // Handle known AppErrors
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      details: err.details
    });
  }

  // Prisma errors
  if (err.name === 'PrismaClientKnownRequestError' || (err as any).constructor?.name === 'PrismaClientKnownRequestError') {
    const prismaErr = err as any;
    if (prismaErr.code === 'P2002') {
      const field = prismaErr.meta?.target?.[0] || 'field';
      return res.status(409).json({
        error: `A record with this ${field} already exists`,
        code: 'CONFLICT'
      });
    }
    return res.status(400).json({
      error: 'Database operation failed',
      code: 'DB_ERROR'
    });
  }

  // Zod validation errors
  if (err.name === 'ZodError') {
    return res.status(400).json({
      error: 'Invalid request data',
      code: 'VALIDATION_ERROR',
      details: (err as any).errors
    });
  }

  // Unknown errors — never expose stack traces
  return res.status(500).json({
    error: 'Something went wrong. Please try again.',
    code: 'INTERNAL_ERROR'
  });
}
