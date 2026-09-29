import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { getProvider } from '../providers/provider.factory';
import { TokenRegistryService } from './tokenRegistry.service';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SUPPORTED_FIAT = ['NGN', 'USD', 'EUR'] as const;
type SupportedFiatCurrency = (typeof SUPPORTED_FIAT)[number];

export interface CreateQuoteParams {
  sourceToken: string;
  sourceMint: string;
  sourceAmount: string;
  fiatCurrency: string;
  actor?: {
    type: 'consumer' | 'merchant';
    id: string;
  };
}

export interface QuoteResponse {
  quoteId: string;
  sourceToken: string;
  sourceAmount: string;
  sourceMint: string;
  intermediateToken: string;
  intermediateAmount: string;
  fiatCurrency: string;
  fiatAmount: string;
  rate: string;
  fee: string;
  networkFee: string;
  netAmount: string;
  route: {
    swap: string;
    provider: string;
    mock: boolean;
    [key: string]: any;
  };
  expiresAt: string;
}

export interface StoredQuoteWithStatus extends QuoteResponse {
  isExpired: boolean;
  isUsed: boolean;
  secondsRemaining: number;
}

// In-memory fallback for local development or when PostgreSQL connection is down
const memoryQuotes = new Map<string, any>();

export class QuoteService {
  /**
   * Generate and store a conversion quote
   */
  static async createQuote(params: CreateQuoteParams): Promise<QuoteResponse> {
    const { sourceToken, sourceMint, sourceAmount, fiatCurrency, actor } = params;

    if (!sourceToken || !sourceMint || !sourceAmount || !fiatCurrency) {
      throw new Error('sourceToken, sourceMint, sourceAmount, and fiatCurrency are required');
    }

    const numAmount = Number(sourceAmount);
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error('sourceAmount must be a positive number');
    }

    const upperFiat = fiatCurrency.toUpperCase();
    if (!SUPPORTED_FIAT.includes(upperFiat as SupportedFiatCurrency)) {
      throw new Error(`Unsupported fiat currency: ${fiatCurrency}. Supported currencies are NGN, USD, EUR.`);
    }

    // Validate token against registry (DB or fallback)
    try {
      const { tokens: allTokens } = await TokenRegistryService.getSellableTokens({ limit: 200 });
      const tokenExists = allTokens.some(
        (t: any) => t.mint.toLowerCase() === sourceMint.toLowerCase() || t.symbol.toUpperCase() === sourceToken.toUpperCase()
      );
      if (!tokenExists && !sourceMint.startsWith('So1') && !sourceMint.startsWith('EPj') && !sourceMint.startsWith('Dez')) {
        logger.warn(`[QuoteService] Token ${sourceToken} (${sourceMint}) not found in token registry, proceeding with fallback.`);
      }
    } catch (err) {
      logger.warn('[QuoteService] Registry check error:', err);
    }

    // 1. Swap quote: sourceToken → intermediateToken (USDC)
    let intermediateAmount = sourceAmount;
    let swapRouteSummary = `${sourceToken} → USDC`;

    if (sourceMint === USDC_MINT || sourceToken.toUpperCase() === 'USDC') {
      intermediateAmount = sourceAmount;
      swapRouteSummary = 'USDC → USDC (Direct)';
    } else {
      const jupiter = getProvider('jupiter');
      const jupQuote = await jupiter.getSwapQuote({
        inputMint: sourceMint,
        outputMint: USDC_MINT,
        amount: sourceAmount,
      });
      intermediateAmount = jupQuote.outAmount;
      swapRouteSummary = `${sourceToken} → USDC`;
    }

    // 2. Provider quote: USDC → fiat (NGN/USD/EUR)
    let fiatAmountStr = '0.00';
    let rateStr = '1.0';
    let providerName = 'OneLiquidity';

    if (upperFiat === 'NGN') {
      const ngnProvider = getProvider('ngn');
      const ngnQuote = await ngnProvider.getFiatQuote({
        cryptoAmount: intermediateAmount,
        fiatCurrency: 'NGN',
      });
      fiatAmountStr = ngnQuote.fiatAmount;
      rateStr = ngnQuote.rate;
      providerName = 'OneLiquidity';
    } else {
      const usdEurProvider = getProvider('usdeur');
      const fiatQuote = await usdEurProvider.getFiatQuote({
        cryptoAmount: intermediateAmount,
        fiatCurrency: upperFiat as 'USD' | 'EUR',
      });
      fiatAmountStr = fiatQuote.fiatAmount;
      rateStr = fiatQuote.rate;
      providerName = 'Transak';
    }

    // 3. Fee calculation
    // FluxPay fee: 0.5% of total fiat amount
    const fiatNum = Number(fiatAmountStr);
    const fluxPayFee = Number((fiatNum * 0.005).toFixed(2));
    // Network fee: fixed small amount in fiat (0.15 NGN or 0.01 USD/EUR)
    const networkFee = upperFiat === 'NGN' ? 0.15 : 0.01;
    const netAmount = Math.max(0, Number((fiatNum - fluxPayFee - networkFee).toFixed(2)));

    // 4. Expiry: 30 seconds from now
    const expiresAt = new Date(Date.now() + 30 * 1000);
    const quoteId = `q_${randomBytes(8).toString('hex')}`;

    const routeData = {
      swap: swapRouteSummary,
      provider: providerName,
      mock: process.env.USE_MOCK_PROVIDERS === 'true',
    };

    const quoteRecord = {
      id: quoteId,
      userId: actor?.type === 'consumer' ? actor.id : null,
      merchantId: actor?.type === 'merchant' ? actor.id : null,
      sourceToken,
      sourceMint,
      sourceAmount,
      intermediateToken: 'USDC',
      intermediateAmount,
      fiatCurrency: upperFiat,
      fiatAmount: fiatAmountStr,
      rate: rateStr,
      fee: fluxPayFee.toFixed(2),
      networkFee: networkFee.toFixed(2),
      netAmount: netAmount.toFixed(2),
      route: routeData,
      expiresAt,
      used: false,
      createdAt: new Date(),
    };

    // Attempt DB storage, fallback to memory
    try {
      await prisma.quote.create({
        data: quoteRecord,
      });
    } catch (dbErr) {
      logger.warn('[QuoteService] Database write error, saving to memory fallback:', dbErr);
    }
    memoryQuotes.set(quoteId, quoteRecord);

    return {
      quoteId,
      sourceToken,
      sourceAmount,
      sourceMint,
      intermediateToken: 'USDC',
      intermediateAmount,
      fiatCurrency: upperFiat,
      fiatAmount: fiatAmountStr,
      rate: rateStr,
      fee: fluxPayFee.toFixed(2),
      networkFee: networkFee.toFixed(2),
      netAmount: netAmount.toFixed(2),
      route: routeData,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Retrieve a stored quote with expiration & remaining seconds
   */
  static async getQuoteById(quoteId: string): Promise<StoredQuoteWithStatus | null> {
    let quote: any = null;

    try {
      quote = await prisma.quote.findUnique({
        where: { id: quoteId },
      });
    } catch (dbErr) {
      logger.warn(`[QuoteService] DB lookup error for quote ${quoteId}, checking memory fallback`);
    }

    if (!quote) {
      quote = memoryQuotes.get(quoteId) || null;
    }

    if (!quote) {
      return null;
    }

    const now = new Date();
    const expiryDate = new Date(quote.expiresAt);
    const isExpired = quote.used || now > expiryDate;
    const msRemaining = expiryDate.getTime() - now.getTime();
    const secondsRemaining = isExpired ? 0 : Math.max(0, Math.floor(msRemaining / 1000));

    return {
      quoteId: quote.id,
      sourceToken: quote.sourceToken,
      sourceAmount: quote.sourceAmount,
      sourceMint: quote.sourceMint,
      intermediateToken: quote.intermediateToken || 'USDC',
      intermediateAmount: quote.intermediateAmount,
      fiatCurrency: quote.fiatCurrency,
      fiatAmount: quote.fiatAmount,
      rate: quote.rate,
      fee: quote.fee,
      networkFee: quote.networkFee,
      netAmount: quote.netAmount,
      route: typeof quote.route === 'string' ? JSON.parse(quote.route) : quote.route,
      expiresAt: expiryDate.toISOString(),
      isExpired,
      isUsed: Boolean(quote.used),
      secondsRemaining,
    };
  }

  /**
   * Mark a quote as used
   */
  static async markQuoteUsed(quoteId: string): Promise<void> {
    try {
      await prisma.quote.update({
        where: { id: quoteId },
        data: { used: true },
      });
    } catch (err) {
      // Ignore if DB fails
    }

    const mem = memoryQuotes.get(quoteId);
    if (mem) {
      mem.used = true;
      memoryQuotes.set(quoteId, mem);
    }
  }

  /**
   * Release a quote (mark unused)
   */
  static async releaseQuote(quoteId: string): Promise<void> {
    try {
      await prisma.quote.update({
        where: { id: quoteId },
        data: { used: false },
      });
    } catch (err) {
      // Ignore if DB fails
    }

    const mem = memoryQuotes.get(quoteId);
    if (mem) {
      mem.used = false;
      memoryQuotes.set(quoteId, mem);
    }
  }

  /**
   * Cleanup expired quotes (called by background job)
   */
  static async cleanupExpiredQuotes(): Promise<number> {
    const now = new Date();
    let cleanedCount = 0;

    try {
      const result = await prisma.quote.deleteMany({
        where: {
          expiresAt: { lt: now },
        },
      });
      cleanedCount += result.count;
    } catch (err) {
      // Fallback
    }

    for (const [id, q] of memoryQuotes.entries()) {
      if (new Date(q.expiresAt) < now) {
        memoryQuotes.delete(id);
        cleanedCount++;
      }
    }

    return cleanedCount;
  }
}
