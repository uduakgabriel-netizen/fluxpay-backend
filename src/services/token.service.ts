import { logger } from '../utils/logger';
/**
 * Token Service — PRODUCTION
 *
 * Manages the supported token registry:
 * - Fetches ALL tokens from Jupiter API (not limited to 10)
 * - Caches in database for fast lookups
 * - Auto-refreshes every 24 hours
 * - Falls back to last cached data if Jupiter API fails
 * - Supports search/filter for merchant token selection
 */

import { PrismaClient } from '@prisma/client'
import { cacheService } from './cache.service'

const prisma = new PrismaClient()

// Minimum fallback tokens — used ONLY if database is empty AND Jupiter API is down
const CORE_FALLBACK_TOKENS = [
  {
    symbol: 'SOL',
    mint: 'So11111111111111111111111111111111111111112',
    name: 'Solana',
    decimals: 9,
    logoUrl: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.svg',
    rank: 1,
  },
  {
    symbol: 'USDC',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    name: 'USD Coin',
    decimals: 6,
    logoUrl: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.svg',
    rank: 2,
  },
  {
    symbol: 'USDT',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    name: 'Tether USD',
    decimals: 6,
    logoUrl: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg',
    rank: 3,
  },
  {
    symbol: 'BONK',
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    name: 'Bonk',
    decimals: 5,
    logoUrl: 'https://arweave.net/hQiPZOsRZXG32Tjq8CDZvydg9qYp8c2w_AId_1y8vGo',
    rank: 4,
  },
  {
    symbol: 'JUP',
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    name: 'Jupiter',
    decimals: 6,
    logoUrl: 'https://static.jup.ag/jup/icon.png',
    rank: 5,
  },
  {
    symbol: 'WIF',
    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    name: 'dogwifhat',
    decimals: 6,
    logoUrl: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm/logo.png',
    rank: 6,
  },
  {
    symbol: 'PYTH',
    mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTrPvuqWeoPj',
    name: 'Pyth Network',
    decimals: 6,
    logoUrl: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTrPvuqWeoPj/logo.png',
    rank: 7,
  },
]

// Jupiter's verified tokens API — returns verified tokens with metadata
const JUPITER_TOKEN_API = 'https://token.jup.ag/all'
const JUPITER_STRICT_API = 'https://token.jup.ag/strict' // Only verified/strict tokens

export class TokenService {
  /**
   * Get all active supported tokens from database cache.
   * Supports optional search query and pagination.
   */
  static async getSupportedTokens(options?: {
    search?: string
    limit?: number
    offset?: number
  }) {
    try {
      const where: any = { isActive: true }

      // Add search filter if provided
      if (options?.search) {
        const searchTerm = options.search.trim()
        where.OR = [
          { symbol: { contains: searchTerm, mode: 'insensitive' } },
          { name: { contains: searchTerm, mode: 'insensitive' } },
          { mint: { contains: searchTerm } },
        ]
      } else {
        // Only use cache if there is no search filter
        const cacheKey = `tokens:all:${options?.limit || 500}:${options?.offset || 0}`;
        const cachedTokens = await cacheService.get(cacheKey);
        if (cachedTokens) return cachedTokens;
      }

      const tokens = await (prisma as any).supportedToken.findMany({
        where,
        orderBy: { rank: 'asc' },
        take: options?.limit || 500, // Default to 500 tokens
        skip: options?.offset || 0,
      })

      if (tokens.length === 0) {
        if (!options?.search) {
          logger.warn('No tokens in cache, using core fallback list');
          return CORE_FALLBACK_TOKENS;
        } else {
          const searchTerm = options.search.toLowerCase();
          return CORE_FALLBACK_TOKENS.filter(t => 
            t.symbol.toLowerCase().includes(searchTerm) || 
            t.name.toLowerCase().includes(searchTerm) || 
            t.mint.toLowerCase().includes(searchTerm)
          );
        }
      }

      if (!options?.search) {
         const cacheKey = `tokens:all:${options?.limit || 500}:${options?.offset || 0}`;
         await cacheService.set(cacheKey, tokens, 24 * 60 * 60); // 24 hours
      }

      return tokens
    } catch (error) {
      logger.error('Error fetching supported tokens:', error)
      return CORE_FALLBACK_TOKENS
    }
  }

  /**
   * Get the total count of active supported tokens.
   */
  static async getTokenCount(): Promise<number> {
    try {
      return await (prisma as any).supportedToken.count({
        where: { isActive: true },
      })
    } catch {
      return CORE_FALLBACK_TOKENS.length
    }
  }

  /**
   * Get a specific token by mint address
   */
  static async getTokenByMint(mint: string) {
    try {
      const token = await (prisma as any).supportedToken.findUnique({
        where: { mint },
      })
      return token
    } catch (error) {
      logger.error('Error fetching token by mint:', error)
      const fallback = CORE_FALLBACK_TOKENS.find((t) => t.mint === mint)
      return fallback || null
    }
  }

  /**
   * Get a specific token by symbol
   */
  static async getTokenBySymbol(symbol: string) {
    try {
      const token = await (prisma as any).supportedToken.findFirst({
        where: { symbol: symbol.toUpperCase() },
      })
      return token
    } catch (error) {
      logger.error('Error fetching token by symbol:', error)
      const fallback = CORE_FALLBACK_TOKENS.find((t) => t.symbol === symbol.toUpperCase())
      return fallback || null
    }
  }

  /**
   * Refresh token cache from Jupiter API.
   *
   * Fetches ALL verified tokens (not just 10) and caches them in the database.
   * Uses the "strict" API for verified tokens with good metadata.
   *
   * Strategy:
   * 1. Fetch from Jupiter strict API (verified tokens only)
   * 2. If that fails, fetch from Jupiter all API
   * 3. If both fail, keep existing cached data (never wipe the DB)
   * 4. If DB is empty and API fails, seed with core fallback tokens
   */
  static async refreshTokenCache() {
    try {
      logger.info('[TokenService] Starting full token cache refresh from Jupiter...')

      let jupiterTokens: any[] = []

      // Try strict API first (better quality, ~1000 tokens)
      try {
        const response = await Promise.race([
          fetch(JUPITER_STRICT_API),
          new Promise<Response>((_, reject) =>
            setTimeout(() => reject(new Error('Strict API timeout')), 30000)
          ),
        ]) as Response

        if (response.ok) {
          jupiterTokens = (await response.json()) as any[]
          logger.info(`[TokenService] Fetched ${jupiterTokens.length} verified tokens from Jupiter strict API`)
        }
      } catch (err: any) {
        logger.warn(`[TokenService] Strict API failed (${err.message}), trying full API...`)
      }

      // Fallback to full API if strict failed
      if (jupiterTokens.length === 0) {
        try {
          const response = await Promise.race([
            fetch(JUPITER_TOKEN_API),
            new Promise<Response>((_, reject) =>
              setTimeout(() => reject(new Error('Full API timeout')), 30000)
            ),
          ]) as Response

          if (response.ok) {
            jupiterTokens = (await response.json()) as any[]
            logger.info(`[TokenService] Fetched ${jupiterTokens.length} tokens from Jupiter full API`)
          }
        } catch (err: any) {
          logger.error(`[TokenService] Full API also failed: ${err.message}`)
        }
      }

      // If we got no tokens from Jupiter, don't wipe the existing cache
      if (!Array.isArray(jupiterTokens) || jupiterTokens.length === 0) {
        logger.warn('[TokenService] No tokens received from Jupiter. Preserving existing cache.')

        // If database is also empty, seed with core fallback
        const existingCount = await (prisma as any).supportedToken.count()
        if (existingCount === 0) {
          logger.info('[TokenService] Database empty — seeding core fallback tokens')
          await this.seedFallbackTokens()
        }

        return
      }

      // Filter tokens with valid data
      const validTokens = jupiterTokens.filter((t: any) => {
        const address = t.address || t.mint
        return (
          address &&
          t.symbol &&
          t.name &&
          typeof t.decimals === 'number' &&
          t.symbol.length <= 20 &&
          t.name.length <= 100
        )
      })

      logger.info(`[TokenService] Processing ${validTokens.length} valid tokens...`)

      // Batch upsert tokens into database
      let upsertedCount = 0
      const batchSize = 50

      for (let i = 0; i < validTokens.length; i += batchSize) {
        const batch = validTokens.slice(i, i + batchSize)

        const promises = batch.map((token: any, index: number) => {
          const mint = token.address || token.mint || ''
          return (prisma as any).supportedToken.upsert({
            where: { mint },
            update: {
              symbol: token.symbol,
              name: token.name,
              decimals: token.decimals,
              logoUrl: token.logoURI || token.logoUrl || '',
              rank: i + index + 1,
              isActive: true,
              updatedAt: new Date(),
            },
            create: {
              mint,
              symbol: token.symbol,
              name: token.name,
              decimals: token.decimals,
              logoUrl: token.logoURI || token.logoUrl || '',
              rank: i + index + 1,
              isActive: true,
            },
          })
        })

        try {
          await Promise.all(promises)
          upsertedCount += batch.length
        } catch (batchError: any) {
          // If batch fails, try individually
          for (const token of batch) {
            try {
              const mint = token.address || token.mint || ''
              await (prisma as any).supportedToken.upsert({
                where: { mint },
                update: {
                  symbol: token.symbol,
                  name: token.name,
                  decimals: token.decimals,
                  logoUrl: token.logoURI || token.logoUrl || '',
                  rank: upsertedCount + 1,
                  isActive: true,
                  updatedAt: new Date(),
                },
                create: {
                  mint,
                  symbol: token.symbol,
                  name: token.name,
                  decimals: token.decimals,
                  logoUrl: token.logoURI || token.logoUrl || '',
                  rank: upsertedCount + 1,
                  isActive: true,
                },
              })
              upsertedCount++
            } catch (individualError) {
              // Skip tokens that fail (e.g., duplicate mints)
            }
          }
        }
      }

      logger.info(`[TokenService] ✓ Successfully cached ${upsertedCount} tokens from Jupiter`)
    } catch (error) {
      logger.error('[TokenService] Error refreshing token cache:', error)

      // Ensure we always have at least the core tokens
      const existingCount = await (prisma as any).supportedToken.count()
      if (existingCount === 0) {
        logger.info('[TokenService] Database empty after error — seeding core fallback tokens')
        await this.seedFallbackTokens()
      }
    }
  }

  /**
   * Seed the database with core fallback tokens.
   * Only called when database is empty AND Jupiter API fails.
   */
  private static async seedFallbackTokens() {
    for (const token of CORE_FALLBACK_TOKENS) {
      try {
        await (prisma as any).supportedToken.upsert({
          where: { mint: token.mint },
          update: {
            isActive: true,
            updatedAt: new Date(),
          },
          create: {
            mint: token.mint,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            logoUrl: token.logoUrl,
            rank: token.rank,
            isActive: true,
          },
        })
      } catch (error) {
        // Ignore individual failures
      }
    }
    logger.info(`[TokenService] Seeded ${CORE_FALLBACK_TOKENS.length} core fallback tokens`)
  }

  /**
   * Validate a token mint address exists in supported tokens
   */
  static async isTokenSupported(mint: string): Promise<boolean> {
    const token = await this.getTokenByMint(mint)
    return token ? true : false
  }
}

export default TokenService
