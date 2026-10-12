import { TokenRegistryService, CORE_SELLABLE_TOKENS } from '../../services/tokenRegistry.service';
import * as jupiterAdapter from '../../providers/jupiter/jupiter-token.adapter';

describe('Token Registry & Jupiter Adapter (Unit Tests)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Token Querying & Fallback', () => {
    it('returns core sellable tokens when DB is unpopulated', async () => {
      const result = await TokenRegistryService.getSellableTokens({ limit: 10 });
      expect(result.tokens).toBeDefined();
      expect(result.tokens.length).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeGreaterThanOrEqual(1);

      // Verify shape
      const first = result.tokens[0];
      expect(first.mint).toBeDefined();
      expect(first.symbol).toBeDefined();
      expect(first.name).toBeDefined();
      expect(typeof first.decimals).toBe('number');
      expect(first).toHaveProperty('logoURI');
    });

    it('filters tokens by search query (case-insensitive symbol or name)', async () => {
      const result = await TokenRegistryService.getSellableTokens({ search: 'bonk' });
      expect(result.tokens.length).toBeGreaterThanOrEqual(1);
      for (const token of result.tokens) {
        const matches =
          token.symbol.toLowerCase().includes('bonk') ||
          token.name.toLowerCase().includes('bonk');
        expect(matches).toBe(true);
      }
    });

    it('respects limit and offset parameters', async () => {
      const result = await TokenRegistryService.getSellableTokens({ limit: 2, offset: 0 });
      expect(result.tokens.length).toBeLessThanOrEqual(2);
    });

    it('finds single token by mint', async () => {
      const bonkMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
      const token = await TokenRegistryService.getSellableTokenByMint(bonkMint);
      expect(token).not.toBeNull();
      expect(token?.symbol).toBe('BONK');
      expect(token?.mint).toBe(bonkMint);
    });

    it('returns null for nonexistent token mint', async () => {
      const nonexistentMint = 'NonExistentMintAddress1111111111111111111111';
      const token = await TokenRegistryService.getSellableTokenByMint(nonexistentMint);
      expect(token).toBeNull();
    });
  });

  describe('Jupiter Adapter Resilience', () => {
    it('returns empty array when all Jupiter endpoints fail, without throwing', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockRejectedValue(new Error('Network offline'));

      const tokens = await jupiterAdapter.fetchTokensFromJupiter();
      expect(Array.isArray(tokens)).toBe(true);
      expect(tokens.length).toBe(0);

      global.fetch = originalFetch;
    });

    it('preserves existing token cache if Jupiter is down', async () => {
      jest.spyOn(jupiterAdapter, 'fetchTokensFromJupiter').mockResolvedValue([]);

      const result = await TokenRegistryService.refreshTokens();
      expect(result.total).toBeGreaterThanOrEqual(CORE_SELLABLE_TOKENS.length);
    });
  });
});
