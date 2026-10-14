import { Response } from 'express';
import { QuoteService } from '../services/quote.service';
import { AuthContextRequest } from '../middleware/requireConsumerOrMerchantAuth';
import { logger } from '../utils/logger';

export class QuoteController {
  /**
   * POST /api/offramp/quote
   * Generate conversion quote (consumer or merchant or guest)
   */
  static async createQuote(req: AuthContextRequest, res: Response): Promise<void> {
    try {
      const { sourceToken, sourceMint, sourceAmount, fiatCurrency } = req.body;

      if (!sourceToken || !sourceMint || !sourceAmount || !fiatCurrency) {
        res.status(400).json({
          error: 'Missing required parameters: sourceToken, sourceMint, sourceAmount, and fiatCurrency are required.',
        });
        return;
      }

      const quote = await QuoteService.createQuote({
        sourceToken,
        sourceMint,
        sourceAmount: String(sourceAmount),
        fiatCurrency,
        actor: req.actor,
      });

      res.status(200).json(quote);
    } catch (error: any) {
      logger.error('[QuoteController] createQuote error:', error);
      res.status(400).json({ error: error.message || 'Failed to generate quote' });
    }
  }

  /**
   * GET /api/offramp/quote/:quoteId
   * Retrieve a stored quote with expiry status
   */
  static async getQuote(req: AuthContextRequest, res: Response): Promise<void> {
    try {
      const { quoteId } = req.params;

      if (!quoteId) {
        res.status(400).json({ error: 'quoteId parameter is required' });
        return;
      }

      const quote = await QuoteService.getQuoteById(quoteId);

      if (!quote) {
        res.status(404).json({ error: 'Quote not found' });
        return;
      }

      if (quote.isExpired) {
        res.status(400).json({
          error: 'Quote has expired',
          isExpired: true,
          isUsed: quote.isUsed,
          secondsRemaining: 0,
          quoteId: quote.quoteId,
        });
        return;
      }

      res.status(200).json(quote);
    } catch (error: any) {
      logger.error('[QuoteController] getQuote error:', error);
      res.status(500).json({ error: 'Internal server error while retrieving quote' });
    }
  }

  /**
   * GET /api/offramp/quote
   * Takes query parameters: inputMint (or sourceMint), outputMint, amount (or sourceAmount), fiatCurrency
   */
  static async getOrQueryQuote(req: AuthContextRequest, res: Response): Promise<void> {
    try {
      const sourceMint = (req.query.sourceMint || req.query.inputMint) as string;
      const sourceAmount = (req.query.sourceAmount || req.query.amount) as string;
      const fiatCurrency = ((req.query.fiatCurrency || 'NGN') as string).toUpperCase();
      let sourceToken = (req.query.sourceToken || '') as string;

      if (!sourceMint || !sourceAmount) {
        res.status(400).json({
          error: 'Missing required query parameters: inputMint (or sourceMint) and amount are required.',
        });
        return;
      }

      if (!sourceToken) {
        if (sourceMint.startsWith('So1')) sourceToken = 'SOL';
        else if (sourceMint.startsWith('EPj')) sourceToken = 'USDC';
        else if (sourceMint.startsWith('Es9')) sourceToken = 'USDT';
        else if (sourceMint.startsWith('Dez')) sourceToken = 'BONK';
        else sourceToken = 'TOKEN';
      }

      const quote = await QuoteService.createQuote({
        sourceToken,
        sourceMint,
        sourceAmount: String(sourceAmount),
        fiatCurrency,
        actor: req.actor,
      });

      res.status(200).json(quote);
    } catch (error: any) {
      logger.error('[QuoteController] getOrQueryQuote error:', error);
      res.status(400).json({ error: error.message || 'Failed to generate quote' });
    }
  }
}
