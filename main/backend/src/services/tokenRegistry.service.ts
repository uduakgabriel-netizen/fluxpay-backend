import { PrismaClient } from '@prisma/client';
import { fetchTokensFromJupiter, NormalizedToken } from '../providers/jupiter/jupiter-token.adapter';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export const CORE_SELLABLE_TOKENS: NormalizedToken[] = [
  {
    symbol: 'SOL',
    mint: 'So11111111111111111111111111111111111111112',
    name: 'Solana',
    decimals: 9,
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.svg',
  },
  {
    symbol: 'USDC',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    name: 'USD Coin',
    decimals: 6,
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.svg',
  },
  {
    symbol: 'USDT',
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    name: 'Tether USD',
    decimals: 6,
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg',
  },
  {
    symbol: 'BONK',
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    name: 'Bonk',
    decimals: 5,
    logoURI: 'https://arweave.net/hQiPZOsRZXG32Tjq8CDZvydg9qYp8c2w_AId_1y8vGo',
  },
  {
    symbol: 'JUP',
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    name: 'Jupiter',
    decimals: 6,
    logoURI: 'https://static.jup.ag/jup/icon.png',
  },
  {
    symbol: 'WIF',
    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    name: 'dogwifhat',
    decimals: 6,
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm/logo.png',
  },
  {
    symbol: 'PYTH',
    mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTrPvuqWeoPj',
    name: 'Pyth Network',
    decimals: 6,
    logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTrPvuqWeoPj/logo.png',
  },
];

// In-memory fallback token cache to ensure the platform never fails
const memoryTokens = new Map<string, NormalizedToken>(
  CORE_SELLABLE_TOKENS.map((t) => [t.mint, t])
);

export interface GetSellableTokensParams {
  search?: string;
  limit?: number;
  offset?: number;
}

export interface GetSellableTokensResult {
  tokens: NormalizedToken[];
  total: number;
}

export class TokenRegistryService {
  /**
   * Sync fresh tokens from Jupiter and upsert into database.
   * Logs added, updated, and existing count.
   * If Jupiter is down, preserves existing cache and seeds fallback if empty.
   */
  static async refreshTokens(): Promise<{ added: number; updated: number; total: number }> {
    logger.info('[TokenRegistryService] Starting token refresh from Jupiter...');
    const tokens = await fetchTokensFromJupiter();

    if (!tokens || tokens.length === 0) {
      logger.warn('[TokenRegistryService] Jupiter returned no tokens. Preserving existing token cache.');

      // Check if DB is empty; if so, seed core fallback tokens
      try {
        const count = await prisma.supportedToken.count();
        if (count === 0) {
          await this.seedCoreTokens();
        }
      } catch (err) {
        logger.warn('[TokenRegistryService] Could not check DB count during fallback:', err);
      }

      return { added: 0, updated: 0, total: memoryTokens.size };
    }

    let added = 0;
    let updated = 0;

    // Update in-memory cache immediately
    for (const t of tokens) {
      if (!memoryTokens.has(t.mint)) {
        added++;
      } else {
        updated++;
      }
      memoryTokens.set(t.mint, t);
    }

    // Persist to database in batches
    const batchSize = 100;
    for (let i = 0; i < tokens.length; i += batchSize) {
      const batch = tokens.slice(i, i + batchSize);
      try {
        await Promise.all(
          batch.map((token, index) =>
            prisma.supportedToken.upsert({
              where: { mint: token.mint },
              update: {
                symbol: token.symbol,
                name: token.name,
                decimals: token.decimals,
                logoUrl: token.logoURI || undefined,
                logoURI: token.logoURI || undefined,
                isActive: true,
                updatedAt: new Date(),
              },
              create: {
                mint: token.mint,
                symbol: token.symbol,
                name: token.name,
                decimals: token.decimals,
                logoUrl: token.logoURI || undefined,
                logoURI: token.logoURI || undefined,
                rank: i + index + 1,
                isActive: true,
              },
            })
          )
        );
      } catch (err) {
        logger.warn(`[TokenRegistryService] Error upserting batch ${i / batchSize}:`, err);
      }
    }

    const total = memoryTokens.size;
    logger.info(
      `[TokenRegistryService] Token refresh completed: ${added} added, ${updated} updated, ${total} total tokens available.`
    );

    return { added, updated, total };
  }

  /**
   * Seed core fallback tokens into the database
   */
  static async seedCoreTokens(): Promise<void> {
    logger.info('[TokenRegistryService] Seeding core fallback tokens into database...');
    for (const token of CORE_SELLABLE_TOKENS) {
      memoryTokens.set(token.mint, token);
      try {
        await prisma.supportedToken.upsert({
          where: { mint: token.mint },
          update: {
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            logoUrl: token.logoURI,
            logoURI: token.logoURI,
            isActive: true,
            updatedAt: new Date(),
          },
          create: {
            mint: token.mint,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            logoUrl: token.logoURI,
            logoURI: token.logoURI,
            isActive: true,
          },
        });
      } catch (err) {
        logger.warn(`[TokenRegistryService] Fallback seed DB write failed for ${token.symbol}:`, err);
      }
    }
  }

  /**
   * Return sellable tokens reading from DB (with in-memory fallback)
   */
  static async getSellableTokens(params?: GetSellableTokensParams): Promise<GetSellableTokensResult> {
    const rawLimit = params?.limit ? Number(params.limit) : 50;
    const limit = isNaN(rawLimit) || rawLimit <= 0 ? 50 : Math.min(rawLimit, 200);
    const rawOffset = params?.offset ? Number(params.offset) : 0;
    const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;
    const search = params?.search?.trim();

    try {
      const where: any = { isActive: true };

      if (search) {
        where.OR = [
          { symbol: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
        ];
      }

      const [dbTokens, total] = await Promise.all([
        prisma.supportedToken.findMany({
          where,
          take: limit,
          skip: offset,
          orderBy: [{ rank: 'asc' }, { symbol: 'asc' }],
          select: {
            mint: true,
            symbol: true,
            name: true,
            decimals: true,
            logoURI: true,
            logoUrl: true,
          },
        }),
        prisma.supportedToken.count({ where }),
      ]);

      if (total > 0) {
        return {
          tokens: dbTokens.map((t) => ({
            mint: t.mint,
            symbol: t.symbol,
            name: t.name,
            decimals: t.decimals,
            logoURI: t.logoURI || t.logoUrl || null,
          })),
          total,
        };
      }
    } catch (err) {
      logger.warn('[TokenRegistryService] DB query failed, falling back to in-memory tokens:', err);
    }

    // In-memory fallback
    let allTokens = Array.from(memoryTokens.values());
    if (search) {
      const lowerSearch = search.toLowerCase();
      allTokens = allTokens.filter(
        (t) =>
          t.symbol.toLowerCase().includes(lowerSearch) ||
          t.name.toLowerCase().includes(lowerSearch)
      );
    }

    const total = allTokens.length;
    const pagedTokens = allTokens.slice(offset, offset + limit);

    return {
      tokens: pagedTokens,
      total,
    };
  }

  /**
   * Return a single sellable token by its Solana mint address
   */
  static async getSellableTokenByMint(mint: string): Promise<NormalizedToken | null> {
    const normalizedMint = mint.trim();

    try {
      const dbToken = await prisma.supportedToken.findFirst({
        where: {
          mint: normalizedMint,
          isActive: true,
        },
        select: {
          mint: true,
          symbol: true,
          name: true,
          decimals: true,
          logoURI: true,
          logoUrl: true,
        },
      });

      if (dbToken) {
        return {
          mint: dbToken.mint,
          symbol: dbToken.symbol,
          name: dbToken.name,
          decimals: dbToken.decimals,
          logoURI: dbToken.logoURI || dbToken.logoUrl || null,
        };
      }
    } catch (err) {
      logger.warn('[TokenRegistryService] DB findFirst failed, checking memory cache:', err);
    }

    const memToken = memoryTokens.get(normalizedMint);
    return memToken || null;
  }
}
