import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { getProvider } from '../providers/provider.factory';
import { encrypt, decrypt, maskAccountNumber } from '../utils/encryption';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

export interface AuthenticatedActor {
  type: 'consumer' | 'merchant';
  id: string;
}

export interface BankAccountResponse {
  id: string;
  accountName: string;
  accountNumber: string; // Always masked
  bankName: string;
  bankCode?: string;
  currency: string;
  isVerified: boolean;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateBankAccountParams {
  accountNumber: string;
  bankCode: string;
  bankName: string;
  currency: string;
  accountName: string;
  setDefault?: boolean;
  actor: AuthenticatedActor;
}

export interface UpdateBankAccountParams {
  setDefault?: boolean;
  accountName?: string;
}

// In-memory fallback for local dev or when PostgreSQL is unreachable
const memoryBankAccounts = new Map<string, any>();

export class PayoutAccountService {
  /**
   * Helper to format an account record for safe API response (masks account number)
   */
  private static formatAccount(record: any): BankAccountResponse {
    let plain = '';
    try {
      plain = decrypt(record.accountNumber);
    } catch {
      plain = record.accountNumber;
    }

    return {
      id: record.id,
      accountName: record.accountName,
      accountNumber: maskAccountNumber(plain),
      bankName: record.bankName,
      bankCode: record.bankCode,
      currency: record.currency,
      isVerified: Boolean(record.isVerified),
      isDefault: Boolean(record.isDefault),
      createdAt: record.createdAt ? new Date(record.createdAt).toISOString() : undefined,
      updatedAt: record.updatedAt ? new Date(record.updatedAt).toISOString() : undefined,
    };
  }

  /**
   * List supported banks for a given country/currency (public endpoint)
   */
  static async listBanks(params: { country?: string; currency?: string }): Promise<{ banks: any[]; total: number }> {
    const currency = (params.currency || (params.country === 'NG' ? 'NGN' : 'NGN')).toUpperCase();

    let banks: any[] = [];
    if (currency === 'NGN') {
      const ngnProvider = getProvider('ngn');
      banks = await ngnProvider.listBanks();
    } else {
      const usdEurProvider = getProvider('usdeur');
      banks = await usdEurProvider.listBanks(currency as 'USD' | 'EUR');
    }

    return {
      banks,
      total: banks.length,
    };
  }

  /**
   * Verify an account number with a bank via provider adapter
   */
  static async verifyAccount(params: { accountNumber: string; bankCode: string; currency?: string }): Promise<{
    accountName: string;
    accountNumber: string;
    bankName: string;
    bankCode: string;
    verified: boolean;
  }> {
    const { accountNumber, bankCode } = params;
    const currency = (params.currency || 'NGN').toUpperCase();

    if (!accountNumber || !bankCode) {
      throw { status: 400, message: 'accountNumber and bankCode are required' };
    }

    // Format validation
    if (currency === 'NGN') {
      const cleanAcct = accountNumber.replace(/\s+/g, '');
      if (!/^\d{10}$/.test(cleanAcct)) {
        throw { status: 400, message: 'Invalid account number format. Nigerian bank accounts must be exactly 10 digits.' };
      }
    } else {
      const cleanAcct = accountNumber.replace(/[\s-]+/g, '');
      if (cleanAcct.length < 8 || cleanAcct.length > 20) {
        throw { status: 400, message: 'Invalid account number format. Must be between 8 and 20 characters.' };
      }
    }

    try {
      if (currency === 'NGN') {
        const ngn = getProvider('ngn');
        const res = await ngn.verifyBankAccount({ accountNumber, bankCode });
        return {
          accountName: res.accountName,
          accountNumber: res.accountNumber,
          bankName: res.bankName,
          bankCode,
          verified: true,
        };
      } else {
        const usdeur = getProvider('usdeur');
        const res = await usdeur.verifyBankAccount({
          accountNumber,
          bankCode,
          currency: currency as 'USD' | 'EUR',
        });
        return {
          accountName: res.accountName,
          accountNumber: res.accountNumber,
          bankName: res.bankName,
          bankCode,
          verified: true,
        };
      }
    } catch (err: any) {
      logger.error('[PayoutAccountService] Provider verify error:', err);
      throw { status: 422, message: 'Provider could not verify account' };
    }
  }

  /**
   * Save a verified payout account with AES-256-GCM encryption
   */
  static async createAccount(params: CreateBankAccountParams): Promise<BankAccountResponse> {
    const { accountNumber, bankCode, bankName, currency, accountName, setDefault, actor } = params;

    if (!accountNumber || !bankCode || !bankName || !currency || !accountName) {
      throw { status: 400, message: 'All account fields (accountNumber, bankCode, bankName, currency, accountName) are required' };
    }

    const cleanAcct = accountNumber.trim();
    const upperCurrency = currency.toUpperCase();

    // Validate format
    if (upperCurrency === 'NGN' && !/^\d{10}$/.test(cleanAcct)) {
      throw { status: 400, message: 'Invalid account number format. Must be 10 digits for NGN.' };
    }

    // Encrypt account number before saving
    const encryptedAccountNumber = encrypt(cleanAcct);
    const id = `acct_${randomBytes(8).toString('hex')}`;

    const isConsumer = actor.type === 'consumer';
    const userId = isConsumer ? actor.id : null;
    const merchantId = !isConsumer ? actor.id : null;

    // Check existing accounts count for this user
    let existingCount = 0;
    try {
      existingCount = await prisma.bankAccount.count({
        where: isConsumer ? { userId: actor.id } : { merchantId: actor.id },
      });
    } catch {
      for (const item of memoryBankAccounts.values()) {
        if ((isConsumer && item.userId === actor.id) || (!isConsumer && item.merchantId === actor.id)) {
          existingCount++;
        }
      }
    }

    // If first account or setDefault is requested, mark as default
    const makeDefault = Boolean(setDefault || existingCount === 0);

    // If setting as default, unset other defaults
    if (makeDefault) {
      try {
        await prisma.bankAccount.updateMany({
          where: isConsumer ? { userId: actor.id, isDefault: true } : { merchantId: actor.id, isDefault: true },
          data: { isDefault: false },
        });
      } catch (e) {
        // Fallback
      }

      for (const [key, item] of memoryBankAccounts.entries()) {
        if ((isConsumer && item.userId === actor.id) || (!isConsumer && item.merchantId === actor.id)) {
          item.isDefault = false;
          memoryBankAccounts.set(key, item);
        }
      }
    }

    const record = {
      id,
      userId,
      merchantId,
      accountName,
      accountNumber: encryptedAccountNumber,
      bankName,
      bankCode,
      currency: upperCurrency,
      provider: upperCurrency === 'NGN' ? 'oneLiquidity' : 'transak',
      providerRefId: null,
      isVerified: true,
      isDefault: makeDefault,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      await prisma.bankAccount.create({
        data: record,
      });
    } catch (dbErr) {
      logger.warn('[PayoutAccountService] DB write error, storing in memory fallback:', dbErr);
    }
    memoryBankAccounts.set(id, record);

    return this.formatAccount(record);
  }

  /**
   * List all accounts for the authenticated actor (strict isolation)
   */
  static async listAccounts(actor: AuthenticatedActor): Promise<{ accounts: BankAccountResponse[]; total: number }> {
    const isConsumer = actor.type === 'consumer';
    let dbAccounts: any[] = [];

    try {
      dbAccounts = await prisma.bankAccount.findMany({
        where: isConsumer ? { userId: actor.id } : { merchantId: actor.id },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      });
    } catch (err) {
      logger.warn('[PayoutAccountService] DB findMany error, querying memory fallback');
    }

    if (dbAccounts.length === 0) {
      for (const item of memoryBankAccounts.values()) {
        if ((isConsumer && item.userId === actor.id) || (!isConsumer && item.merchantId === actor.id)) {
          dbAccounts.push(item);
        }
      }
    }

    const accounts = dbAccounts.map((a) => this.formatAccount(a));
    return {
      accounts,
      total: accounts.length,
    };
  }

  /**
   * Get single account by ID with strict ownership check
   */
  static async getAccountById(id: string, actor: AuthenticatedActor): Promise<BankAccountResponse> {
    const isConsumer = actor.type === 'consumer';
    let account: any = null;

    try {
      account = await prisma.bankAccount.findUnique({
        where: { id },
      });
    } catch (err) {
      // Memory fallback
    }

    if (!account) {
      account = memoryBankAccounts.get(id);
    }

    if (!account) {
      throw { status: 404, message: 'Account not found' };
    }

    // Strict owner check
    const ownerId = isConsumer ? account.userId : account.merchantId;
    if (ownerId !== actor.id) {
      throw { status: 403, message: 'Access denied. You do not own this payout account.' };
    }

    return this.formatAccount(account);
  }

  /**
   * Update payout account (e.g. set as default, update name)
   */
  static async updateAccount(id: string, updates: UpdateBankAccountParams, actor: AuthenticatedActor): Promise<BankAccountResponse> {
    const existing = await this.getAccountById(id, actor);
    const isConsumer = actor.type === 'consumer';

    if (updates.setDefault) {
      // Unset other defaults
      try {
        await prisma.bankAccount.updateMany({
          where: isConsumer ? { userId: actor.id, isDefault: true } : { merchantId: actor.id, isDefault: true },
          data: { isDefault: false },
        });
      } catch (err) {
        // Fallback
      }

      for (const [key, item] of memoryBankAccounts.entries()) {
        if ((isConsumer && item.userId === actor.id) || (!isConsumer && item.merchantId === actor.id)) {
          item.isDefault = false;
          memoryBankAccounts.set(key, item);
        }
      }
    }

    const dataToUpdate: any = {};
    if (typeof updates.setDefault === 'boolean') {
      dataToUpdate.isDefault = updates.setDefault;
    }
    if (updates.accountName) {
      dataToUpdate.accountName = updates.accountName;
    }
    dataToUpdate.updatedAt = new Date();

    let updatedRecord: any = null;
    try {
      updatedRecord = await prisma.bankAccount.update({
        where: { id },
        data: dataToUpdate,
      });
    } catch (err) {
      // Memory fallback
    }

    if (!updatedRecord) {
      const mem = memoryBankAccounts.get(id);
      if (mem) {
        Object.assign(mem, dataToUpdate);
        memoryBankAccounts.set(id, mem);
        updatedRecord = mem;
      }
    }

    return this.formatAccount(updatedRecord || existing);
  }

  /**
   * Delete payout account and auto-promote another default if needed
   */
  static async deleteAccount(id: string, actor: AuthenticatedActor): Promise<{ success: boolean; message: string }> {
    const existing = await this.getAccountById(id, actor);
    const wasDefault = existing.isDefault;
    const isConsumer = actor.type === 'consumer';

    try {
      await prisma.bankAccount.delete({
        where: { id },
      });
    } catch (err) {
      // Memory fallback
    }
    memoryBankAccounts.delete(id);

    // If deleted account was default, set another verified account as default
    if (wasDefault) {
      let otherAccount: any = null;
      try {
        otherAccount = await prisma.bankAccount.findFirst({
          where: isConsumer ? { userId: actor.id, isVerified: true } : { merchantId: actor.id, isVerified: true },
        });

        if (otherAccount) {
          await prisma.bankAccount.update({
            where: { id: otherAccount.id },
            data: { isDefault: true },
          });
        }
      } catch (err) {
        // Fallback
      }

      if (!otherAccount) {
        for (const [k, item] of memoryBankAccounts.entries()) {
          if (((isConsumer && item.userId === actor.id) || (!isConsumer && item.merchantId === actor.id)) && item.isVerified) {
            item.isDefault = true;
            memoryBankAccounts.set(k, item);
            break;
          }
        }
      }
    }

    return {
      success: true,
      message: 'Account deleted successfully',
    };
  }
}
