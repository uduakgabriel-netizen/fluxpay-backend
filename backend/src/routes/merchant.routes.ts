import express from 'express'
import { getMerchantInfo, updatePreferredToken, getMerchantBalance } from '../controllers/merchant.controller'
import * as secretController from '../controllers/secret.controller'
import { requireAuth } from '../middleware/auth.middleware'

const router = express.Router()

// Protected routes (require authentication)
router.get('/me', requireAuth, getMerchantInfo)
router.put('/preferred-token', requireAuth, updatePreferredToken)
router.get('/balance', requireAuth, getMerchantBalance)

// Secret Management (API Keys)
router.get('/api-key', requireAuth, secretController.getApiKeyInfo as any)
router.post('/api-key/roll', requireAuth, secretController.rollApiKey as any)
router.post('/api-key/revoke', requireAuth, secretController.revokeApiKey as any)

// Secret Management (Webhooks)
router.get('/webhook', requireAuth, secretController.getWebhookInfo as any)
router.post('/webhook/roll', requireAuth, secretController.rollWebhookSecret as any)
router.put('/webhook/url', requireAuth, secretController.updateWebhookUrl as any)

export default router
