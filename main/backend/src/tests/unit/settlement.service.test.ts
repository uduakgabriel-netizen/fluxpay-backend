import { SettlementService } from '../../services/settlement.service';
import { MerchantSettingsService } from '../../services/merchantSettings.service';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ProviderError,
} from '../../errors/AppError';

// Mock Prisma
const mockMerchantFindUnique = jest.fn();
const mockMerchantFindMany = jest.fn();
const mockMerchantUpdate = jest.fn();
const mockBankAccountFindUnique = jest.fn();
const mockPaymentFindMany = jest.fn();
const mockPaymentUpdateMany = jest.fn();
const mockSettlementFindUnique = jest.fn();
const mockSettlementFindFirst = jest.fn();
const mockSettlementFindMany = jest.fn();
const mockSettlementCount = jest.fn();
const mockSettlementCreate = jest.fn();
const mockSettlementUpdate = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    merchant: {
      findUnique: (...args: any[]) => mockMerchantFindUnique(...args),
      findMany: (...args: any[]) => mockMerchantFindMany(...args),
      update: (...args: any[]) => mockMerchantUpdate(...args),
    },
    bankAccount: {
      findUnique: (...args: any[]) => mockBankAccountFindUnique(...args),
    },
    payment: {
      findMany: (...args: any[]) => mockPaymentFindMany(...args),
      updateMany: (...args: any[]) => mockPaymentUpdateMany(...args),
    },
    settlement: {
      findUnique: (...args: any[]) => mockSettlementFindUnique(...args),
      findFirst: (...args: any[]) => mockSettlementFindFirst(...args),
      findMany: (...args: any[]) => mockSettlementFindMany(...args),
      count: (...args: any[]) => mockSettlementCount(...args),
      create: (...args: any[]) => mockSettlementCreate(...args),
      update: (...args: any[]) => mockSettlementUpdate(...args),
    },
  })),
  SettlementStatus: {
    PENDING: 'PENDING',
    PROCESSING: 'PROCESSING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    RETRYING: 'RETRYING',
  },
}));

describe('Merchant Settlement Engine (Stage 6 Unit Tests)', () => {
  const merchantId = 'merchant_123';

  const verifiedBankAccount = {
    id: 'bank_acct_1',
    merchantId,
    bankName: 'OPay',
    accountNumber: '0801234589',
    accountName: 'UDUAK GABRIEL AKPAN',
    currency: 'NGN',
    isVerified: true,
    provider: 'ngn-mock',
  };

  const fiatMerchant = {
    id: merchantId,
    settlementType: 'FIAT',
    settlementCurrency: 'NGN',
    defaultPayoutAccountId: 'bank_acct_1',
  };

  beforeAll(() => {
    process.env.USE_MOCK_PROVIDERS = 'true';
    process.env.NODE_ENV = 'test';
    process.env.MOCK_FAILURE_RATE = '0';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.MOCK_FORCE_PAYOUT_FAIL;
  });

  describe('Merchant Settings Service', () => {
    it('getSettlementSettings throws NotFoundError if merchant is not found', async () => {
      mockMerchantFindUnique.mockResolvedValue(null);
      await expect(
        MerchantSettingsService.getSettlementSettings('unknown')
      ).rejects.toThrow(NotFoundError);
    });

    it('getSettlementSettings returns masked bank account', async () => {
      mockMerchantFindUnique.mockResolvedValue(fiatMerchant);
      mockBankAccountFindUnique.mockResolvedValue(verifiedBankAccount);

      const res = await MerchantSettingsService.getSettlementSettings(merchantId);
      expect(res.settlementType).toBe('FIAT');
      expect(res.settlementCurrency).toBe('NGN');
      expect(res.defaultPayoutAccount?.accountNumber).toBe('080******89');
    });

    it('updateSettlementSettings validates settlementType', async () => {
      await expect(
        MerchantSettingsService.updateSettlementSettings(merchantId, { settlementType: 'INVALID' })
      ).rejects.toThrow(ValidationError);
    });

    it('updateSettlementSettings requires currency and payout account for FIAT', async () => {
      mockMerchantFindUnique.mockResolvedValue({ id: merchantId });

      await expect(
        MerchantSettingsService.updateSettlementSettings(merchantId, {
          settlementType: 'FIAT',
          settlementCurrency: '',
          defaultPayoutAccountId: '',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('updateSettlementSettings throws ForbiddenError if bank account belongs to another merchant', async () => {
      mockMerchantFindUnique.mockResolvedValue({ id: merchantId });
      mockBankAccountFindUnique.mockResolvedValue({
        ...verifiedBankAccount,
        merchantId: 'different_merchant',
      });

      await expect(
        MerchantSettingsService.updateSettlementSettings(merchantId, {
          settlementType: 'FIAT',
          settlementCurrency: 'NGN',
          defaultPayoutAccountId: 'bank_acct_1',
        })
      ).rejects.toThrow(ForbiddenError);
    });

    it('updateSettlementSettings throws ValidationError if bank account is unverified', async () => {
      mockMerchantFindUnique.mockResolvedValue({ id: merchantId });
      mockBankAccountFindUnique.mockResolvedValue({
        ...verifiedBankAccount,
        isVerified: false,
      });

      await expect(
        MerchantSettingsService.updateSettlementSettings(merchantId, {
          settlementType: 'FIAT',
          settlementCurrency: 'NGN',
          defaultPayoutAccountId: 'bank_acct_1',
        })
      ).rejects.toThrow(ValidationError);
    });

    it('updateSettlementSettings successfully updates to FIAT', async () => {
      mockMerchantFindUnique.mockResolvedValue({ id: merchantId });
      mockBankAccountFindUnique.mockResolvedValue(verifiedBankAccount);
      mockMerchantUpdate.mockResolvedValue({});

      const res = await MerchantSettingsService.updateSettlementSettings(merchantId, {
        settlementType: 'FIAT',
        settlementCurrency: 'NGN',
        defaultPayoutAccountId: 'bank_acct_1',
      });

      expect(res.settlementType).toBe('FIAT');
      expect(res.settlementCurrency).toBe('NGN');
      expect(res.defaultPayoutAccount?.accountName).toBe('UDUAK GABRIEL AKPAN');
    });

    it('updateSettlementSettings successfully updates to CRYPTO', async () => {
      mockMerchantFindUnique.mockResolvedValue(fiatMerchant);
      mockMerchantUpdate.mockResolvedValue({});

      const res = await MerchantSettingsService.updateSettlementSettings(merchantId, {
        settlementType: 'CRYPTO',
      });

      expect(res.settlementType).toBe('CRYPTO');
      expect(res.defaultPayoutAccount).toBeNull();
    });
  });

  describe('Settlement Service: triggerSettlement()', () => {
    it('throws ValidationError if merchant is not configured for FIAT', async () => {
      mockMerchantFindUnique.mockResolvedValue({
        id: merchantId,
        settlementType: 'CRYPTO',
      });

      await expect(
        SettlementService.triggerSettlement(merchantId)
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError if merchant has no default payout account', async () => {
      mockMerchantFindUnique.mockResolvedValue({
        id: merchantId,
        settlementType: 'FIAT',
        defaultPayoutAccountId: null,
      });

      await expect(
        SettlementService.triggerSettlement(merchantId)
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError if no completed unsettled payments exist', async () => {
      mockMerchantFindUnique.mockResolvedValue(fiatMerchant);
      mockBankAccountFindUnique.mockResolvedValue(verifiedBankAccount);
      mockPaymentFindMany.mockResolvedValue([]);

      await expect(
        SettlementService.triggerSettlement(merchantId)
      ).rejects.toThrow(ValidationError);
    });

    it('handles provider failure during payout, marks settlement FAILED and throws ProviderError', async () => {
      process.env.MOCK_FORCE_PAYOUT_FAIL = 'true';
      mockMerchantFindUnique.mockResolvedValue(fiatMerchant);
      mockBankAccountFindUnique.mockResolvedValue(verifiedBankAccount);
      mockPaymentFindMany.mockResolvedValue([
        { id: 'pay_1', amount: 50, status: 'COMPLETED', settled: false },
      ]);
      mockSettlementCreate.mockResolvedValue({
        id: 'settle_fail_1',
        status: 'PENDING',
      });

      await expect(
        SettlementService.triggerSettlement(merchantId)
      ).rejects.toThrow(ProviderError);

      expect(mockSettlementUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'settle_fail_1' },
          data: expect.objectContaining({
            status: 'FAILED',
            errorCode: 'PROVIDER_ERROR',
          }),
        })
      );
    });

    it('happy path: creates settlement, executes payout, marks COMPLETED and marks payments settled', async () => {
      mockMerchantFindUnique.mockResolvedValue(fiatMerchant);
      mockBankAccountFindUnique.mockResolvedValue(verifiedBankAccount);
      mockPaymentFindMany.mockResolvedValue([
        { id: 'pay_1', amount: 100, status: 'COMPLETED', settled: false },
        { id: 'pay_2', amount: 50, status: 'COMPLETED', settled: false },
      ]);
      mockSettlementCreate.mockResolvedValue({
        id: 'settle_happy_1',
        status: 'PENDING',
      });
      mockSettlementUpdate.mockResolvedValue({
        id: 'settle_happy_1',
        status: 'COMPLETED',
        createdAt: new Date(),
        updatedAt: new Date(),
        settledAt: new Date(),
      });
      mockPaymentUpdateMany.mockResolvedValue({ count: 2 });

      const res = await SettlementService.triggerSettlement(merchantId);
      expect(res.id).toBe('settle_happy_1');
      expect(res.status).toBe('COMPLETED');
      expect(mockPaymentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['pay_1', 'pay_2'] } },
          data: expect.objectContaining({ settled: true }),
        })
      );
    });
  });

  describe('Settlement Service: list & getById', () => {
    it('listMerchantSettlements returns paginated list for merchant', async () => {
      mockSettlementFindMany.mockResolvedValue([
        {
          id: 'settle_1',
          merchantId,
          status: 'COMPLETED',
          currency: 'NGN',
          grossAmount: '150.00',
          fiatAmount: '228450.00',
          fxRate: '1523',
          fee: '1142.25',
          netAmount: '227307.75',
          provider: 'ngn-mock',
          paymentIds: ['pay_1', 'pay_2'],
          createdAt: new Date(),
          updatedAt: new Date(),
          settledAt: new Date(),
        },
      ]);
      mockSettlementCount.mockResolvedValue(1);

      const res = await SettlementService.listMerchantSettlements(merchantId, { limit: 10 });
      expect(res.settlements.length).toBe(1);
      expect(res.settlements[0].paymentCount).toBe(2);
      expect(res.total).toBe(1);
    });

    it('getMerchantSettlementById throws NotFoundError if not found', async () => {
      mockSettlementFindUnique.mockResolvedValue(null);
      await expect(
        SettlementService.getMerchantSettlementById(merchantId, 'non_existent')
      ).rejects.toThrow(NotFoundError);
    });

    it('getMerchantSettlementById throws ForbiddenError if owned by another merchant', async () => {
      mockSettlementFindUnique.mockResolvedValue({
        id: 'settle_other',
        merchantId: 'other_merchant',
      });
      await expect(
        SettlementService.getMerchantSettlementById(merchantId, 'settle_other')
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe('Daily Settlement Cron: processDailyFiatSettlement()', () => {
    it('skips merchant if already settled today (idempotency)', async () => {
      mockMerchantFindMany.mockResolvedValue([fiatMerchant]);
      mockSettlementFindFirst.mockResolvedValue({ id: 'already_settled_today' });

      const res = await SettlementService.processDailyFiatSettlement();
      expect(res.skipped).toBe(1);
      expect(res.processed).toBe(0);
    });

    it('processes eligible fiat merchant with completed payments', async () => {
      mockMerchantFindMany.mockResolvedValue([fiatMerchant]);
      mockSettlementFindFirst.mockResolvedValue(null); // not settled today
      mockBankAccountFindUnique.mockResolvedValue(verifiedBankAccount);
      mockPaymentFindMany.mockResolvedValue([
        { id: 'pay_1', amount: 50, status: 'COMPLETED', settled: false },
      ]);
      mockSettlementCreate.mockResolvedValue({
        id: 'settle_daily_1',
        status: 'PENDING',
      });
      mockSettlementUpdate.mockResolvedValue({});
      mockPaymentUpdateMany.mockResolvedValue({});

      const res = await SettlementService.processDailyFiatSettlement();
      expect(res.processed).toBe(1);
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(0);
    });
  });

  describe('Settlement Retry Job: retryFailedSettlements()', () => {
    it('retries failed settlements with retryCount < 3 and marks COMPLETED on success', async () => {
      mockSettlementFindMany.mockResolvedValue([
        {
          id: 'settle_failed_retry',
          status: 'FAILED',
          retryCount: 1,
          currency: 'NGN',
          netAmount: '1000.00',
          bankAccountId: 'bank_acct_1',
          paymentIds: ['pay_fail_1'],
        },
      ]);
      mockBankAccountFindUnique.mockResolvedValue(verifiedBankAccount);
      mockSettlementUpdate.mockResolvedValue({});
      mockPaymentUpdateMany.mockResolvedValue({});

      const res = await SettlementService.retryFailedSettlements();
      expect(res.retried).toBe(1);
      expect(res.succeeded).toBe(1);
      expect(res.failed).toBe(0);
    });
  });
});
