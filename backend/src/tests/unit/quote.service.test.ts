import { QuoteService } from '../../services/quote.service';
import { getProvider } from '../../providers/provider.factory';

describe('Quote Engine Service & Adapters (Stage 3 Unit Tests)', () => {
  const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  beforeAll(() => {
    process.env.USE_MOCK_PROVIDERS = 'true';
  });

  describe('Provider Factory & Adapters', () => {
    it('returns mock providers when USE_MOCK_PROVIDERS=true', async () => {
      const jupiter = getProvider('jupiter');
      const ngn = getProvider('ngn');
      const usdeur = getProvider('usdeur');

      expect(jupiter).toBeDefined();
      expect(ngn).toBeDefined();
      expect(usdeur).toBeDefined();

      const swapQuote = await jupiter.getSwapQuote({
        inputMint: BONK_MINT,
        outputMint: USDC_MINT,
        amount: '10000',
      });
      expect(swapQuote.outAmount).toBeDefined();
      expect(swapQuote.route.mock).toBe(true);

      const ngnQuote = await ngn.getFiatQuote({
        cryptoAmount: '1',
        fiatCurrency: 'NGN',
      });
      expect(ngnQuote.rate).toBe('1523');
      expect(ngnQuote.fiatAmount).toBe('1523.00');

      const usdQuote = await usdeur.getFiatQuote({
        cryptoAmount: '10',
        fiatCurrency: 'USD',
      });
      expect(usdQuote.rate).toBe('1');
      expect(usdQuote.fiatAmount).toBe('10.00');
    });
  });

  describe('Quote Generation & Calculations', () => {
    it('generates a full quote for BONK → NGN with accurate fee breakdown', async () => {
      const quote = await QuoteService.createQuote({
        sourceToken: 'BONK',
        sourceMint: BONK_MINT,
        sourceAmount: '10000',
        fiatCurrency: 'NGN',
        actor: { type: 'consumer', id: 'user_test_123' },
      });

      expect(quote).toBeDefined();
      expect(quote.quoteId).toMatch(/^q_/);
      expect(quote.sourceToken).toBe('BONK');
      expect(quote.sourceAmount).toBe('10000');
      expect(quote.intermediateToken).toBe('USDC');
      expect(Number(quote.intermediateAmount)).toBeGreaterThan(0);
      expect(quote.fiatCurrency).toBe('NGN');
      expect(Number(quote.fiatAmount)).toBeGreaterThan(0);

      // Fee calculations: 0.5% FluxPay fee + 0.15 NGN network fee
      const fiat = Number(quote.fiatAmount);
      const expectedFluxPayFee = Number((fiat * 0.005).toFixed(2));
      expect(Number(quote.fee)).toBeCloseTo(expectedFluxPayFee, 2);
      expect(Number(quote.networkFee)).toBe(0.15);

      const expectedNet = Math.max(0, Number((fiat - expectedFluxPayFee - 0.15).toFixed(2)));
      expect(Number(quote.netAmount)).toBeCloseTo(expectedNet, 2);

      // Route
      expect(quote.route).toBeDefined();
      expect(quote.route.swap).toBe('BONK → USDC');
      expect(quote.route.provider).toBe('OneLiquidity');
      expect(quote.route.mock).toBe(true);

      // Expiry (30 seconds from now)
      const expiry = new Date(quote.expiresAt).getTime();
      const now = Date.now();
      expect(expiry - now).toBeGreaterThan(25000);
      expect(expiry - now).toBeLessThanOrEqual(31000);
    });

    it('bypasses swap when source token is already USDC', async () => {
      const quote = await QuoteService.createQuote({
        sourceToken: 'USDC',
        sourceMint: USDC_MINT,
        sourceAmount: '50',
        fiatCurrency: 'USD',
      });

      expect(quote.intermediateAmount).toBe('50');
      expect(quote.fiatAmount).toBe('50.00');
      expect(Number(quote.fee)).toBe(0.25); // 50 * 0.005
    });

    it('rejects unsupported fiat currencies', async () => {
      await expect(
        QuoteService.createQuote({
          sourceToken: 'BONK',
          sourceMint: BONK_MINT,
          sourceAmount: '1000',
          fiatCurrency: 'GBP',
        })
      ).rejects.toThrow('Unsupported fiat currency');
    });

    it('rejects invalid or non-positive amounts', async () => {
      await expect(
        QuoteService.createQuote({
          sourceToken: 'BONK',
          sourceMint: BONK_MINT,
          sourceAmount: '-500',
          fiatCurrency: 'NGN',
        })
      ).rejects.toThrow('positive number');
    });
  });

  describe('Quote Retrieval & Expiration', () => {
    it('retrieves an active quote with remaining seconds', async () => {
      const created = await QuoteService.createQuote({
        sourceToken: 'BONK',
        sourceMint: BONK_MINT,
        sourceAmount: '5000',
        fiatCurrency: 'NGN',
      });

      const retrieved = await QuoteService.getQuoteById(created.quoteId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.quoteId).toBe(created.quoteId);
      expect(retrieved?.isExpired).toBe(false);
      expect(retrieved?.isUsed).toBe(false);
      expect(retrieved?.secondsRemaining).toBeGreaterThan(0);
      expect(retrieved?.secondsRemaining).toBeLessThanOrEqual(30);
    });

    it('returns null when retrieving non-existent quoteId', async () => {
      const result = await QuoteService.getQuoteById('q_non_existent_999');
      expect(result).toBeNull();
    });

    it('marks quote as used and reflects isExpired=true', async () => {
      const created = await QuoteService.createQuote({
        sourceToken: 'BONK',
        sourceMint: BONK_MINT,
        sourceAmount: '1000',
        fiatCurrency: 'NGN',
      });

      await QuoteService.markQuoteUsed(created.quoteId);
      const retrieved = await QuoteService.getQuoteById(created.quoteId);
      expect(retrieved?.isUsed).toBe(true);
      expect(retrieved?.isExpired).toBe(true);
      expect(retrieved?.secondsRemaining).toBe(0);
    });
  });
});
