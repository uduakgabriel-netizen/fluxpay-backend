import express from 'express'
import {
  getSupportedTokens,
  searchTokens,
  getSwapQuote,
  getMerchantPreferredToken,
  updateMerchantPreferredToken,
} from '../controllers/token.controller'
import { requireAuth } from '../middleware/auth.middleware'

const router = express.Router()

// Public routes
router.get('/supported', getSupportedTokens)
router.get('/search', searchTokens)
router.get('/quote', getSwapQuote)

// Protected routes
router.get('/merchant/preferred', requireAuth, getMerchantPreferredToken)
router.put('/merchant/preferred', requireAuth, updateMerchantPreferredToken)

export default router
