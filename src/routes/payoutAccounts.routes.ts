import { Router } from 'express';
import { PayoutAccountsController } from '../controllers/payoutAccounts.controller';
import { requireConsumerOrMerchantAuth } from '../middleware/requireConsumerOrMerchantAuth';

const router = Router();

// GET /api/payout-accounts/banks (public)
router.get('/banks', PayoutAccountsController.listBanks);

// POST /api/payout-accounts/verify (auth: consumer or merchant)
router.post('/verify', requireConsumerOrMerchantAuth, PayoutAccountsController.verifyAccount);

// POST /api/payout-accounts (auth: consumer or merchant)
router.post('/', requireConsumerOrMerchantAuth, PayoutAccountsController.createAccount);

// GET /api/payout-accounts (auth: consumer or merchant)
router.get('/', requireConsumerOrMerchantAuth, PayoutAccountsController.listAccounts);

// GET /api/payout-accounts/:id (auth: consumer or merchant)
router.get('/:id', requireConsumerOrMerchantAuth, PayoutAccountsController.getAccount);

// PATCH /api/payout-accounts/:id (auth: consumer or merchant)
router.patch('/:id', requireConsumerOrMerchantAuth, PayoutAccountsController.updateAccount);

// DELETE /api/payout-accounts/:id (auth: consumer or merchant)
router.delete('/:id', requireConsumerOrMerchantAuth, PayoutAccountsController.deleteAccount);

export default router;
