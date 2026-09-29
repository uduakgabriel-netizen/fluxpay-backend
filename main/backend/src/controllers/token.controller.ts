import { logger } from '../utils/logger';
import { Request, Response } from 'express'
import { PrismaClient } from '@prisma/client'
import TokenService from '../services/token.service'

const prisma = new PrismaClient()

/**
 * GET /api/tokens/supported
 * Get list of supported tokens (public endpoint)
 */
export async function getSupportedTokens(req: Request, res: Response) {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : undefined;
    const tokens = await TokenService.getSupportedTokens({ limit, offset })
    res.json({ data: tokens })
  } catch (error) {
    logger.error('Error getting supported tokens:', error)
    res.status(500).json({ error: 'Failed to fetch supported tokens' })
  }
}

/**
 * GET /api/tokens/search
 * Search tokens by query
 */
export async function searchTokens(req: Request, res: Response) {
  try {
    const { q, limit, offset } = req.query
    const tokens = await TokenService.getSupportedTokens({ 
      search: q as string,
      limit: limit ? parseInt(limit as string) : 20,
      offset: offset ? parseInt(offset as string) : undefined
    })
    res.json({ data: tokens })
  } catch (error) {
    logger.error('Error searching tokens:', error)
    res.status(500).json({ error: 'Failed to search tokens' })
  }
}

/**
 * GET /api/tokens/quote
 * Get swap quote from Jupiter
 * Query params: inputMint, outputMint, amount, slippageBps (optional, default 100)
 */
export async function getSwapQuote(req: Request, res: Response) {
  try {
    const { inputMint, outputMint, amount, slippageBps = 100 } = req.query

    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({
        error: 'Missing required parameters: inputMint, outputMint, amount',
      })
    }

    // Validate numbers
    const amountNum = BigInt(String(amount))
    const slippageNum = parseInt(String(slippageBps))

    if (amountNum <= 0n) {
      return res.status(400).json({ error: 'Amount must be greater than 0' })
    }

    if (slippageNum < 0 || slippageNum > 10000) {
      return res.status(400).json({ error: 'Slippage must be between 0 and 10000 basis points' })
    }

    // Fetch quote from Jupiter
    const jupiterApiUrl = process.env.JUPITER_API_URL || 'https://api.jup.ag/swap/v2';
    const quoteUrl = new URL(`${jupiterApiUrl}/quote`);
    quoteUrl.searchParams.append('inputMint', String(inputMint))
    quoteUrl.searchParams.append('outputMint', String(outputMint))
    quoteUrl.searchParams.append('amount', String(amount))
    quoteUrl.searchParams.append('slippageBps', String(slippageNum))
    if (req.query.swapMode) {
      quoteUrl.searchParams.append('swapMode', String(req.query.swapMode))
    }
    quoteUrl.searchParams.append('excludeDexes', 'Pump.fun Amm')

    try {
      console.log('Jupiter quote request:', { inputMint, outputMint, amount, swapMode: req.query.swapMode || 'ExactIn' });
      
      const quoteResponse = await Promise.race([
        fetch(quoteUrl.toString()),
        new Promise<globalThis.Response>((_, reject) =>
          setTimeout(() => reject(new Error('Request timeout')), 10000)
        ),
      ]) as globalThis.Response

      const responseText = await quoteResponse.clone().text().catch(() => '');
      console.log('Jupiter quote response:', responseText);

      if (!quoteResponse.ok) {
        return res.status(quoteResponse.status).json({
          error: 'Failed to fetch swap quote from Jupiter',
          message: quoteResponse.statusText,
        })
      }

      const quote = (await quoteResponse.json()) as any

      res.json({
        data: {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          inputAmount: quote.inAmount,
          expectedOutput: quote.outAmount,
          minOutputAmount: quote.otherAmountThreshold,
          priceImpactPct: quote.priceImpactPct,
          routePlan: quote.routePlan,
          slippageBps: slippageNum,
        },
      })
    } catch (error: any) {
      logger.error('Error getting swap quote:', error)
      res.status(500).json({
        error: 'Failed to fetch swap quote',
        message: error?.message,
      })
    }
  } catch (error: any) {
    logger.error('Error getting swap quote:', error)
    res.status(500).json({
      error: 'Failed to fetch swap quote',
      message: error?.message,
    })
  }
}

/**
 * GET /api/merchants/preferred-token
 * Get current merchant's preferred token (authenticated)
 */
export async function getMerchantPreferredToken(req: Request, res: Response) {
  try {
    const merchantId = (req as any).merchantId

    if (!merchantId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const merchant = await (prisma as any).merchant.findUnique({
      where: { id: merchantId },
      select: {
        preferredTokenMint: true,
        preferredTokenSymbol: true,
        preferredTokenDecimals: true,
        hasSelectedToken: true,
        preferredTokenUpdatedAt: true,
      },
    })

    if (!merchant) {
      return res.status(404).json({ error: 'Merchant not found' })
    }

    // If token not selected, block dashboard access
    if (!merchant.hasSelectedToken) {
      return res.status(403).json({ 
        error: 'Token selection required',
        redirect: '/onboarding/token-select',
        hasSelectedToken: false,
      })
    }

    res.json({
      data: {
        mint: merchant.preferredTokenMint,
        symbol: merchant.preferredTokenSymbol,
        decimals: merchant.preferredTokenDecimals,
        selectedAt: merchant.preferredTokenUpdatedAt,
      },
    })
  } catch (error) {
    logger.error('Error getting merchant preferred token:', error)
    res.status(500).json({ error: 'Failed to fetch merchant preferred token' })
  }
}

/**
 * PUT /api/merchants/preferred-token
 * Update merchant's preferred token (authenticated)
 * Body: { symbol: 'USDC' } or { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }
 */
export async function updateMerchantPreferredToken(req: Request, res: Response) {
  try {
    const merchantId = (req as any).merchantId
    const { symbol, mint } = req.body

    if (!merchantId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    if (!symbol && !mint) {
      return res.status(400).json({ error: 'Must provide either symbol or mint' })
    }

    // Resolve token
    let tokenData
    if (mint) {
      tokenData = await TokenService.getTokenByMint(mint)
    } else {
      tokenData = await TokenService.getTokenBySymbol(symbol)
    }

    if (!tokenData) {
      return res.status(400).json({ error: 'Token not found or not supported' })
    }

    // Update merchant
    const updatedMerchant = await (prisma as any).merchant.update({
      where: { id: merchantId },
      data: {
        preferredTokenMint: tokenData.mint,
        preferredTokenSymbol: tokenData.symbol,
        preferredTokenDecimals: tokenData.decimals,
        hasSelectedToken: true,
        preferredTokenUpdatedAt: new Date(),
      },
      select: {
        preferredTokenMint: true,
        preferredTokenSymbol: true,
        preferredTokenDecimals: true,
        preferredTokenUpdatedAt: true,
      },
    })

    res.json({
      data: {
        mint: updatedMerchant.preferredTokenMint,
        symbol: updatedMerchant.preferredTokenSymbol,
        decimals: updatedMerchant.preferredTokenDecimals,
        selectedAt: updatedMerchant.preferredTokenUpdatedAt,
      },
      message: `Preferred token updated to ${updatedMerchant.preferredTokenSymbol}`,
    })
  } catch (error) {
    logger.error('Error updating merchant preferred token:', error)
    res.status(500).json({ error: 'Failed to update preferred token' })
  }
}
