import { logger } from '../../utils/logger';

export interface NormalizedToken {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI: string | null;
}

const DEFAULT_JUPITER_URLS = [
  process.env.JUPITER_TOKEN_API_URL ? `${process.env.JUPITER_TOKEN_API_URL.replace(/\/$/, '')}/all` : '',
  'https://tokens.jup.ag/tokens?tags=verified',
  'https://token.jup.ag/strict',
  'https://token.jup.ag/all',
].filter(Boolean);

/**
 * Fetch and normalize tokens from Jupiter's free public token API.
 * Never crashes on network failure or timeouts — returns an empty array on error.
 */
export async function fetchTokensFromJupiter(): Promise<NormalizedToken[]> {
  for (const url of DEFAULT_JUPITER_URLS) {
    try {
      logger.info(`[JupiterTokenAdapter] Fetching tokens from: ${url}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'FluxPay-Backend/1.0',
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.warn(`[JupiterTokenAdapter] Endpoint returned status ${response.status}: ${url}`);
        continue;
      }

      const rawData = await response.json();
      const tokensArray: any[] = Array.isArray(rawData) ? rawData : (rawData as any)?.tokens || [];

      if (!tokensArray.length) {
        logger.warn(`[JupiterTokenAdapter] No tokens in response from: ${url}`);
        continue;
      }

      // Filter and normalize tokens
      const normalizedTokens: NormalizedToken[] = [];
      const seenMints = new Set<string>();

      for (const t of tokensArray) {
        const mint = (t.address || t.mint || '').trim();
        const symbol = (t.symbol || '').trim();
        const name = (t.name || '').trim();
        const decimals = typeof t.decimals === 'number' ? t.decimals : parseInt(t.decimals, 10);
        const logoURI = t.logoURI || t.logoUrl || null;

        // Validation: must have valid mint, symbol, name, and non-negative integer decimals
        if (
          mint &&
          symbol &&
          name &&
          !isNaN(decimals) &&
          decimals >= 0 &&
          !seenMints.has(mint)
        ) {
          seenMints.add(mint);
          normalizedTokens.push({
            mint,
            symbol,
            name,
            decimals,
            logoURI,
          });
        }
      }

      logger.info(`[JupiterTokenAdapter] Successfully fetched and normalized ${normalizedTokens.length} tokens`);
      return normalizedTokens;
    } catch (error: any) {
      logger.warn(`[JupiterTokenAdapter] Failed to fetch from ${url}: ${error.message}`);
    }
  }

  logger.warn('[JupiterTokenAdapter] All Jupiter token endpoints failed or timed out. Returning empty list.');
  return [];
}
