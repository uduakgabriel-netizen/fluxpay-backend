import { Response } from 'express';
import { PayoutAccountService } from '../services/payoutAccount.service';
import { AuthContextRequest } from '../middleware/requireConsumerOrMerchantAuth';
import { logger } from '../utils/logger';

export class PayoutAccountsController {
  /**
   * GET /api/payout-accounts/banks
   * Public list of supported banks
   */
  static async listBanks(req: AuthContextRequest, res: Response): Promise<void> {
    try {
      const country = req.query.country as string | undefined;
      const currency = req.query.currency as string | undefined;

      const result = await PayoutAccountService.listBanks({ country, currency });
      res.status(200).json(result);
    } catch (error: any) {
      logger.error('[PayoutAccountsController] listBanks error:', error);
      res.status(500).json({ error: 'Failed to retrieve banks' });
    }
  }

  /**
   * POST /api/payout-accounts/verify
   * Verify bank account with provider adapter
   */
  static async verifyAccount(req: AuthContextRequest, res: Response): Promise<void> {
    try {
      const { accountNumber, bankCode, currency } = req.body;

      if (!accountNumber || !bankCode) {
        res.status(400).json({ error: 'accountNumber and bankCode are required' });
        return;
      }

      const result = await PayoutAccountService.verifyAccount({
        accountNumber: String(accountNumber),
        bankCode: String(bankCode),
        currency: currency ? String(currency) : 'NGN',
      });

      res.status(200).json(result);
    } catch (error: any) {
      logger.error('[PayoutAccountsController] verifyAccount error:', error);
      const status = error.status || 400;
      res.status(status).json({ error: error.message || 'Verification failed' });
    }
  }

  /**
   * POST /api/payout-accounts
   * Save a verified payout account
   */
  static async createAccount(req: AuthContextRequest, res: Response): Promise<void> {
    try {
      if (!req.actor) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { accountNumber, bankCode, bankName, currency, accountName, setDefault } = req.body;

      if (!accountNumber || !bankCode || !bankName || !currency || !accountName) {
        res.status(400).json({
          error: 'accountNumber, bankCode, bankName, currency, and accountName are required',
        });
        return;
      }

      const created = await PayoutAccountService.createAccount({
        accountNumber: String(accountNumber),
        bankCode: String(bankCode),
        bankName: String(bankName),
        currency: String(currency),
        accountName: String(accountName),
        setDefault: Boolean(setDefault),
        actor: req.actor,
      });

      res.status(201).json(created);
    } catch (error: any) {
      logger.error('[PayoutAccountsController] createAccount error:', error);
      const status = error.status || 400;
      res.status(status).json({ error: error.message || 'Failed to create payout account' });
    }
  }

  /**
   * GET /api/payout-accounts
   * List all accounts for authenticated actor
   */
  static async listAccounts(req: AuthContextRequest, res: Response): Promise<void> {
    try {
      if (!req.actor) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const result = await PayoutAccountService.listAccounts(req.actor);
      res.status(200).json(result);
    } catch (error: any) {
      logger.error('[PayoutAccountsController] listAccounts error:', error);
      res.status(500).json({ error: 'Failed to retrieve accounts' });
    }
  }

  /**
   * GET /api/payout-accounts/:id
   * Get single account by ID (strict owner check)
   */
  static async getAccount(req: AuthContextRequest, res: Response): Promise<void> {
    try {
      if (!req.actor) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { id } = req.params;
      const account = await PayoutAccountService.getAccountById(id, req.actor);
      res.status(200).json(account);
    } catch (error: any) {
      logger.error('[PayoutAccountsController] getAccount error:', error);
      const status = error.status || 404;
      res.status(status).json({ error: error.message || 'Account not found' });
    }
  }

  /**
   * PATCH /api/payout-accounts/:id
   * Update payout account
   */
  static async updateAccount(req: AuthContextRequest, res: Response): Promise<void> {
    try {
      if (!req.actor) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { id } = req.params;
      const { setDefault, accountName } = req.body;

      const updated = await PayoutAccountService.updateAccount(
        id,
        { setDefault, accountName },
        req.actor
      );

      res.status(200).json(updated);
    } catch (error: any) {
      logger.error('[PayoutAccountsController] updateAccount error:', error);
      const status = error.status || 400;
      res.status(status).json({ error: error.message || 'Failed to update account' });
    }
  }

  /**
   * DELETE /api/payout-accounts/:id
   * Delete payout account
   */
  static async deleteAccount(req: AuthContextRequest, res: Response): Promise<void> {
    try {
      if (!req.actor) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      const { id } = req.params;
      const result = await PayoutAccountService.deleteAccount(id, req.actor);
      res.status(200).json(result);
    } catch (error: any) {
      logger.error('[PayoutAccountsController] deleteAccount error:', error);
      const status = error.status || 400;
      res.status(status).json({ error: error.message || 'Failed to delete account' });
    }
  }
}
