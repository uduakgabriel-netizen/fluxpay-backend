import { OfframpExecutionService } from '../../services/offrampExecution.service';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  QuoteExpiredError,
  ProviderError,
  TransactionStateError,
} from '../../errors/AppError';

// Mock Prisma
const mockQuoteFindUnique = jest.fn();
const mockQuoteUpdate = jest.fn();
const mockQuoteUpdateMany = jest.fn();
const mockBankAccountFindUnique = jest.fn();
const mockTxCreate = jest.fn();
const mockTxFindUnique = jest.fn();
const mockTxFindMany = jest.fn();
const mockTxCount = jest.fn();
const mockTxUpdate = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    quote: {
      findUnique: (...args: any[]) => mockQuoteFindUnique(...args),
      update: (...args: any[]) => mockQuoteUpdate(...args),
      updateMany: (...args: any[]) => mockQuoteUpdateMany(...args),
    },
    bankAccount: {
      findUnique: (...args: any[]) => mockBankAccountFindUnique(...args),
    },
    offRampTransaction: {
      create: (...args: any[]) => mockTxCreate(...args),
      findUnique: (...args: any[]) => mockTxFindUnique(...args),
      findMany: (...args: any[]) => mockTxFindMany(...args),
      count: (...args: any[]) => mockTxCount(...args),
      update: (...args: any[]) => mockTxUpdate(...args),
    },
  })),
  TransactionStatus: {
    PENDING: 'PENDING',
    AWAITING_SIGNATURE: 'AWAITING_SIGNATURE',
    SIGNED: 'SIGNED',
    SWAPPING: 'SWAPPING',
    SWAPPED: 'SWAPPED',
    PAYOUT_PENDING: 'PAYOUT_PENDING',
    PAYOUT_PROCESSING: 'PAYOUT_PROCESSING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    REFUNDED: 'REFUNDED',
  },
}));

describe('OfframpExecutionService (Stage 5 Unit Tests)', () => {
  const mockActorConsumer = { type: 'consumer' as const, id: 'user_123' };
  const mockActorMerchant = { type: 'merchant' as const, id: 'merch_456' };

  const validQuote = {
    id: 'quote_abc',
    userId: 'user_123',
    merchantId: null,
    sourceToken: 'BONK',
    sourceMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    sourceAmount: '100000',
    intermediateToken: 'USDC',
    intermediateAmount: '1.52',
    fiatCurrency: 'NGN',
    fiatAmount: '2314.96',
    rate: '1523',
    fee: '11.57',
    networkFee: '0.005',
    netAmount: '2303.39',
    expiresAt: new Date(Date.now() + 60000), // 1 min in future
    used: false,
  };

  const validBankAccount = {
    id: 'bank_xyz',
    userId: 'user_123',
    merchantId: null,
    bankName: 'OPay',
    accountNumber: '0801234589',
    accountName: 'UDUAK GABRIEL AKPAN',
    currency: 'NGN',
    isVerified: true,
    provider: 'ngn-mock',
  };

  beforeAll(() => {
    process.env.USE_MOCK_PROVIDERS = 'true';
    process.env.NODE_ENV = 'test';
    process.env.MOCK_FAILURE_RATE = '0';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.MOCK_FORCE_SWAP_BUILD_FAIL;
    delete process.env.MOCK_FORCE_SWAP_FAIL;
    delete process.env.MOCK_FORCE_PAYOUT_FAIL;
  });

  describe('execute()', () => {
    it('throws ValidationError if quoteId or bankAccountId is missing', async () => {
      await expect(
        OfframpExecutionService.execute(mockActorConsumer, { quoteId: '', bankAccountId: 'bank_1' })
      ).rejects.toThrow(ValidationError);

      await expect(
        OfframpExecutionService.execute(mockActorConsumer, { quoteId: 'quote_1', bankAccountId: '' })
      ).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError if quote does not exist', async () => {
      mockQuoteFindUnique.mockResolvedValue(null);

      await expect(
        OfframpExecutionService.execute(mockActorConsumer, { quoteId: 'non_existent', bankAccountId: 'bank_1' })
      ).rejects.toThrow(NotFoundError);
    });

    it('throws QuoteExpiredError (410) if quote has expired', async () => {
      mockQuoteFindUnique.mockResolvedValue({
        ...validQuote,
        expiresAt: new Date(Date.now() - 10000), // 10s in past
      });

      await expect(
        OfframpExecutionService.execute(mockActorConsumer, { quoteId: 'quote_abc', bankAccountId: 'bank_xyz' })
      ).rejects.toThrow(QuoteExpiredError);
    });

    it('throws ConflictError (409) if quote has already been used', async () => {
      mockQuoteFindUnique.mockResolvedValue({
        ...validQuote,
        used: true,
      });

      await expect(
        OfframpExecutionService.execute(mockActorConsumer, { quoteId: 'quote_abc', bankAccountId: 'bank_xyz' })
      ).rejects.toThrow(ConflictError);
    });

    it('throws NotFoundError if bank account does not exist', async () => {
      mockQuoteFindUnique.mockResolvedValue(validQuote);
      mockBankAccountFindUnique.mockResolvedValue(null);

      await expect(
        OfframpExecutionService.execute(mockActorConsumer, { quoteId: 'quote_abc', bankAccountId: 'bank_non_existent' })
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError (403) if user attempts to use another user bank account', async () => {
      mockQuoteFindUnique.mockResolvedValue(validQuote);
      mockBankAccountFindUnique.mockResolvedValue({
        ...validBankAccount,
        userId: 'different_user',
      });

      await expect(
        OfframpExecutionService.execute(mockActorConsumer, { quoteId: 'quote_abc', bankAccountId: 'bank_xyz' })
      ).rejects.toThrow(ForbiddenError);
    });

    it('throws ValidationError if bank account currency does not match quote fiat currency', async () => {
      mockQuoteFindUnique.mockResolvedValue(validQuote); // NGN
      mockBankAccountFindUnique.mockResolvedValue({
        ...validBankAccount,
        currency: 'USD',
      });

      await expect(
        OfframpExecutionService.execute(mockActorConsumer, { quoteId: 'quote_abc', bankAccountId: 'bank_xyz' })
      ).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError if bank account is not verified', async () => {
      mockQuoteFindUnique.mockResolvedValue(validQuote);
      mockBankAccountFindUnique.mockResolvedValue({
        ...validBankAccount,
        isVerified: false,
      });

      await expect(
        OfframpExecutionService.execute(mockActorConsumer, { quoteId: 'quote_abc', bankAccountId: 'bank_xyz' })
      ).rejects.toThrow(ValidationError);
    });

    it('handles provider error during build swap transaction, sets status FAILED and throws ProviderError', async () => {
      process.env.MOCK_FORCE_SWAP_BUILD_FAIL = 'true';
      mockQuoteFindUnique.mockResolvedValue(validQuote);
      mockBankAccountFindUnique.mockResolvedValue(validBankAccount);
      mockTxCreate.mockResolvedValue({
        id: 'tx_failed_1',
        status: 'PENDING',
      });

      await expect(
        OfframpExecutionService.execute(mockActorConsumer, { quoteId: 'quote_abc', bankAccountId: 'bank_xyz' })
      ).rejects.toThrow(ProviderError);

      expect(mockTxUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tx_failed_1' },
          data: expect.objectContaining({
            status: 'FAILED',
            errorCode: 'PROVIDER_ERROR',
          }),
        })
      );
    });

    it('happy path: creates transaction, marks quote used, builds swap, updates to AWAITING_SIGNATURE', async () => {
      mockQuoteFindUnique.mockResolvedValue(validQuote);
      mockBankAccountFindUnique.mockResolvedValue(validBankAccount);
      mockTxCreate.mockResolvedValue({
        id: 'tx_happy_1',
        status: 'PENDING',
      });
      mockQuoteUpdate.mockResolvedValue({ ...validQuote, used: true });
      mockTxUpdate.mockResolvedValue({
        id: 'tx_happy_1',
        status: 'AWAITING_SIGNATURE',
      });

      const res = await OfframpExecutionService.execute(mockActorConsumer, {
        quoteId: 'quote_abc',
        bankAccountId: 'bank_xyz',
      });

      expect(res.transactionId).toBe('tx_happy_1');
      expect(res.status).toBe('AWAITING_SIGNATURE');
      expect(res.serializedTransaction).toBeDefined();
      expect(res.bankAccount.accountNumber).toBe('080******89');
      expect(mockQuoteUpdate).toHaveBeenCalledWith({
        where: { id: 'quote_abc' },
        data: { used: true },
      });
    });
  });

  describe('submit()', () => {
    it('throws ValidationError if transactionId or signedTransaction is missing', async () => {
      await expect(
        OfframpExecutionService.submit(mockActorConsumer, { transactionId: '', signedTransaction: 'AQAA...' })
      ).rejects.toThrow(ValidationError);

      await expect(
        OfframpExecutionService.submit(mockActorConsumer, { transactionId: 'tx_1', signedTransaction: '' })
      ).rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError if transaction is not found', async () => {
      mockTxFindUnique.mockResolvedValue(null);

      await expect(
        OfframpExecutionService.submit(mockActorConsumer, { transactionId: 'tx_not_found', signedTransaction: 'AQAA...' })
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ForbiddenError if actor does not own the transaction', async () => {
      mockTxFindUnique.mockResolvedValue({
        id: 'tx_1',
        userId: 'other_user',
        status: 'AWAITING_SIGNATURE',
      });

      await expect(
        OfframpExecutionService.submit(mockActorConsumer, { transactionId: 'tx_1', signedTransaction: 'AQAA...' })
      ).rejects.toThrow(ForbiddenError);
    });

    it('throws TransactionStateError (409) on invalid state transition (submitting completed transaction)', async () => {
      mockTxFindUnique.mockResolvedValue({
        id: 'tx_1',
        userId: 'user_123',
        status: 'COMPLETED',
      });

      await expect(
        OfframpExecutionService.submit(mockActorConsumer, { transactionId: 'tx_1', signedTransaction: 'AQAA...' })
      ).rejects.toThrow(TransactionStateError);
    });

    it('handles swap execution failure: triggers refund flow and throws ProviderError', async () => {
      process.env.MOCK_FORCE_SWAP_FAIL = 'true';
      mockTxFindUnique.mockResolvedValue({
        id: 'tx_swap_fail',
        userId: 'user_123',
        status: 'AWAITING_SIGNATURE',
      });

      await expect(
        OfframpExecutionService.submit(mockActorConsumer, { transactionId: 'tx_swap_fail', signedTransaction: 'AQAA...' })
      ).rejects.toThrow(ProviderError);

      expect(mockTxUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tx_swap_fail' },
          data: { status: 'REFUNDED' },
        })
      );
    });

    it('handles payout execution failure: triggers refund flow and throws ProviderError', async () => {
      process.env.MOCK_FORCE_PAYOUT_FAIL = 'true';
      mockTxFindUnique.mockResolvedValue({
        id: 'tx_payout_fail',
        userId: 'user_123',
        status: 'AWAITING_SIGNATURE',
        bankAccountId: 'bank_xyz',
        fiatCurrency: 'NGN',
        netAmount: '2303.39',
        provider: 'ngn-mock',
      });
      mockBankAccountFindUnique.mockResolvedValue(validBankAccount);

      await expect(
        OfframpExecutionService.submit(mockActorConsumer, { transactionId: 'tx_payout_fail', signedTransaction: 'AQAA...' })
      ).rejects.toThrow(ProviderError);

      expect(mockTxUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tx_payout_fail' },
          data: { status: 'REFUNDED' },
        })
      );
    });

    it('happy path: executes swap and payout, marks COMPLETED with tx hashes', async () => {
      mockTxFindUnique.mockResolvedValue({
        id: 'tx_happy_submit',
        userId: 'user_123',
        status: 'AWAITING_SIGNATURE',
        bankAccountId: 'bank_xyz',
        fiatCurrency: 'NGN',
        netAmount: '2303.39',
        provider: 'ngn-mock',
      });
      mockBankAccountFindUnique.mockResolvedValue(validBankAccount);

      const res = await OfframpExecutionService.submit(mockActorConsumer, {
        transactionId: 'tx_happy_submit',
        signedTransaction: 'AQAA_valid_mock_signature...',
      });

      expect(res.transactionId).toBe('tx_happy_submit');
      expect(res.status).toBe('COMPLETED');
      expect(res.swapTxHash).toContain('mock_swap_');
      expect(res.payoutRefId).toContain('mock_payout_');
      expect(res.completedAt).toBeDefined();
    });
  });

  describe('list() and getById()', () => {
    it('validates limit and offset query parameters', async () => {
      await expect(
        OfframpExecutionService.list(mockActorConsumer, { limit: 0 })
      ).rejects.toThrow(ValidationError);

      await expect(
        OfframpExecutionService.list(mockActorConsumer, { limit: 101 })
      ).rejects.toThrow(ValidationError);

      await expect(
        OfframpExecutionService.list(mockActorConsumer, { offset: -1 })
      ).rejects.toThrow(ValidationError);
    });

    it('returns paginated transactions for authenticated actor', async () => {
      mockTxFindMany.mockResolvedValue([
        {
          id: 'tx_1',
          userId: 'user_123',
          status: 'COMPLETED',
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: new Date(),
        },
      ]);
      mockTxCount.mockResolvedValue(1);

      const res = await OfframpExecutionService.list(mockActorConsumer, { limit: 10, offset: 0 });
      expect(res.transactions.length).toBe(1);
      expect(res.total).toBe(1);
      expect(res.limit).toBe(10);
      expect(res.offset).toBe(0);
    });

    it('getById returns full details with masked bank account', async () => {
      mockTxFindUnique.mockResolvedValue({
        id: 'tx_detail',
        userId: 'user_123',
        bankAccountId: 'bank_xyz',
        status: 'COMPLETED',
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
      });
      mockBankAccountFindUnique.mockResolvedValue(validBankAccount);

      const res = await OfframpExecutionService.getById(mockActorConsumer, 'tx_detail');
      expect(res.id).toBe('tx_detail');
      expect(res.bankAccount?.accountNumber).toBe('080******89');
    });

    it('getById throws ForbiddenError if accessing another user transaction', async () => {
      mockTxFindUnique.mockResolvedValue({
        id: 'tx_other',
        userId: 'user_999',
        status: 'COMPLETED',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expect(
        OfframpExecutionService.getById(mockActorConsumer, 'tx_other')
      ).rejects.toThrow(ForbiddenError);
    });
  });

  describe('getStatus()', () => {
    it('returns correct step information for transactions', async () => {
      mockTxFindUnique.mockResolvedValue({
        id: 'tx_swapping',
        userId: 'user_123',
        status: 'SWAPPING',
      });

      const res = await OfframpExecutionService.getStatus(mockActorConsumer, 'tx_swapping');
      expect(res.id).toBe('tx_swapping');
      expect(res.status).toBe('SWAPPING');
      expect(res.step).toBe(4);
      expect(res.totalSteps).toBe(6);
      expect(res.isTerminal).toBe(false);
    });

    it('returns terminal true for COMPLETED or FAILED or REFUNDED', async () => {
      mockTxFindUnique.mockResolvedValue({
        id: 'tx_done',
        userId: 'user_123',
        status: 'COMPLETED',
      });

      const res = await OfframpExecutionService.getStatus(mockActorConsumer, 'tx_done');
      expect(res.isTerminal).toBe(true);
    });
  });

  describe('cleanupExpiredTransactions()', () => {
    it('cleans up transactions in AWAITING_SIGNATURE older than 10 minutes and releases quote', async () => {
      mockTxFindMany.mockResolvedValue([
        {
          id: 'tx_old_1',
          quoteId: 'quote_old_1',
          status: 'AWAITING_SIGNATURE',
        },
      ]);
      mockTxUpdate.mockResolvedValue({});
      mockQuoteUpdateMany.mockResolvedValue({});

      const cleaned = await OfframpExecutionService.cleanupExpiredTransactions();
      expect(cleaned).toBe(1);
      expect(mockTxUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'tx_old_1' },
          data: expect.objectContaining({
            status: 'FAILED',
            errorCode: 'SIGNATURE_TIMEOUT',
          }),
        })
      );
      expect(mockQuoteUpdateMany).toHaveBeenCalledWith({
        where: { id: 'quote_old_1' },
        data: { used: false },
      });
    });
  });
});
