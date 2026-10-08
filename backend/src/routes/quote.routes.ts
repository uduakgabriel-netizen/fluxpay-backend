import { Router } from 'express';
import { QuoteController } from '../controllers/quote.controller';
import { optionalConsumerOrMerchantAuth } from '../middleware/requireConsumerOrMerchantAuth';

const router = Router();

// POST /api/offramp/quote
router.post('/quote', optionalConsumerOrMerchantAuth, QuoteController.createQuote);

// GET /api/offramp/quote/:quoteId
router.get('/quote/:quoteId', QuoteController.getQuote);

export default router;
