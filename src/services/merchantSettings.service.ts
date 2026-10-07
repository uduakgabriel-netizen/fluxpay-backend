import { PrismaClient } from '@prisma/client';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
} from '../errors/AppError';
import { maskAccountNumber } from '../utils/encryption';
import { logger } from '../utils/logger';
import { PayoutAccountService } from './payoutAccount.service';

const prisma = new PrismaClient();

// In-memory fallback map for merchant settings
export const memoryMerchantSettings = new Map<string, any>();

export interface UpdateSettlementSettingsInput {
  settlementType: string;
  settlementCurrency?: string;
  defaultPayoutAccountId?: string;
}

export class MerchantSettingsService {
  /**
   * Helper: Find merchant with DB + memory fallback
   */
  static async findMerchant(merchantId: string) {
    let merchant = null;
    try {
      merchant = await prisma.merchant.findUnique({
        where: { id: merchantId },
      });
    } catch (err) {
      logger.warn('[MerchantSettings] DB merchant lookup failed, trying memory fallback');
    }

    if (!merchant) {
      merchant = memoryMerchantSettings.get(merchantId) || null;
    }

    return merchant;
  }

  /**
   * Helper: Find bank account with DB + memory fallback
   */
  static async findBankAccount(accountId: string, merchantId: string) {
    let account = null;
    try {
      account = await prisma.bankAccount.findUnique({
        where: { id: accountId },
      });
    } catch (err) {
      logger.warn('[MerchantSettings] DB bank account lookup failed, trying PayoutAccountService fallback');
    }

    if (!account) {
      const b = await (PayoutAccountService as any).getAccountById(accountId, { type: 'merchant', id: merchantId });
      if (b) {
        account = {
          id: b.id,
          merchantId: (b as any).merchantId || merchantId,
          bankName: b.bankName,
          accountNumber: b.accountNumber,
          accountName: b.accountName,
          currency: b.currency,
          isVerified: b.isVerified,
        };
      }
    }

    return account;
  }

  /**
   * GET /api/merchant/settings/settlement
   */
  static async getSettlementSettings(merchantId: string) {
    const merchant = await this.findMerchant(merchantId);
    if (!merchant) {
      throw new NotFoundError('Merchant');
    }

    let defaultPayoutAccount = null;
    if (merchant.defaultPayoutAccountId) {
      const account = await this.findBankAccount(merchant.defaultPayoutAccountId, merchantId);
      if (account) {
        defaultPayoutAccount = {
          id: account.id,
          bankName: account.bankName,
          accountNumber: maskAccountNumber(account.accountNumber),
          accountName: account.accountName,
          isVerified: account.isVerified,
        };
      }
    }

    return {
      settlementType: merchant.settlementType || 'CRYPTO',
      settlementCurrency: merchant.settlementCurrency || null,
      defaultPayoutAccount,
    };
  }

  /**
   * PATCH /api/merchant/settings/settlement
   */
  static async updateSettlementSettings(
    merchantId: string,
    input: UpdateSettlementSettingsInput
  ) {
    if (!input || !input.settlementType) {
      throw new ValidationError('settlementType is required');
    }

    const validTypes = ['CRYPTO', 'FIAT'];
    if (!validTypes.includes(input.settlementType)) {
      throw new ValidationError('settlementType must be either CRYPTO or FIAT');
    }

    const merchant = await this.findMerchant(merchantId);
    if (!merchant) {
      throw new NotFoundError('Merchant');
    }

    if (input.settlementType === 'FIAT') {
      const validCurrencies = ['NGN', 'USD', 'EUR'];
      if (!input.settlementCurrency || !validCurrencies.includes(input.settlementCurrency)) {
        throw new ValidationError('Valid settlementCurrency (NGN, USD, EUR) is required for FIAT settlement');
      }

      if (!input.defaultPayoutAccountId) {
        throw new ValidationError('defaultPayoutAccountId is required for FIAT settlement');
      }

      const account = await this.findBankAccount(input.defaultPayoutAccountId, merchantId);
      if (!account) {
        throw new NotFoundError('Bank account');
      }

      if (account.merchantId && account.merchantId !== merchantId) {
        throw new ForbiddenError('Access denied: You do not own this bank account');
      }

      if (!account.isVerified) {
        throw new ValidationError('Bank account must be verified before setting as default payout account');
      }

      const updateData = {
        settlementType: 'FIAT',
        settlementCurrency: input.settlementCurrency,
        defaultPayoutAccountId: input.defaultPayoutAccountId,
      };

      try {
        await prisma.merchant.update({
          where: { id: merchantId },
          data: updateData,
        });
      } catch (err) {
        logger.warn('[MerchantSettings] DB update merchant failed, updating memory fallback');
      }

      memoryMerchantSettings.set(merchantId, {
        ...(merchant || {}),
        ...updateData,
      });

      return {
        settlementType: 'FIAT',
        settlementCurrency: input.settlementCurrency,
        defaultPayoutAccount: {
          id: account.id,
          bankName: account.bankName,
          accountNumber: maskAccountNumber(account.accountNumber),
          accountName: account.accountName,
          isVerified: account.isVerified,
        },
      };
    }

    // CRYPTO mode
    const updateData = {
      settlementType: 'CRYPTO',
    };

    try {
      await prisma.merchant.update({
        where: { id: merchantId },
        data: updateData,
      });
    } catch (err) {
      logger.warn('[MerchantSettings] DB update merchant failed, updating memory fallback');
    }

    memoryMerchantSettings.set(merchantId, {
      ...(merchant || {}),
      ...updateData,
    });

    return {
      settlementType: 'CRYPTO',
      settlementCurrency: merchant.settlementCurrency || null,
      defaultPayoutAccount: null,
    };
  }
}
