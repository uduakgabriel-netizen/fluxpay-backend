import { logger } from '../utils/logger';
import { Request, Response, NextFunction } from 'express'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/**
 * Middleware to require token selection
 * Returns 403 with redirect URL if token not selected
 * Used on protected dashboard routes
 */
export async function requireTokenSelection(req: Request, res: Response, next: NextFunction) {
  try {
    const merchantId = (req as any).merchantId

    if (!merchantId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const merchant = await (prisma as any).merchant.findUnique({
      where: { id: merchantId },
      select: { hasSelectedToken: true },
    })

    if (!merchant) {
      return res.status(404).json({ error: 'Merchant not found' })
    }

    if (!merchant.hasSelectedToken) {
      return res.status(403).json({
        error: 'Token selection required to access dashboard',
        redirect: '/onboarding/token-select',
        code: 'TOKEN_SELECTION_REQUIRED',
      })
    }

    next()
  } catch (error) {
    logger.error('Error in requireTokenSelection middleware:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
}
