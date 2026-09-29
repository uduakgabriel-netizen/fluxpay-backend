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
}
