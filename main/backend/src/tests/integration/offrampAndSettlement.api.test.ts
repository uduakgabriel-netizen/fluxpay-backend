import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import offrampRoutes from '../../routes/offramp.routes';
import merchantSettingsRoutes from '../../routes/merchantSettings.routes';
import merchantSettlementsRoutes from '../../routes/merchantSettlements.routes';
import { errorHandler } from '../../middleware/errorHandler';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me';

// Mock Prisma
const mockQuoteFindUnique = jest.fn();
const mockQuoteUpdate = jest.fn();
const mockBankAccountFindUnique = jest.fn();
const mockTxCreate = jest.fn();
const mockTxFindUnique = jest.fn();
const mockTxFindMany = jest.fn();
const mockTxCount = jest.fn();
const mockTxUpdate = jest.fn();
const mockMerchantFindUnique = jest.fn();
const mockMerchantUpdate = jest.fn();
const mockPaymentFindMany = jest.fn();
const mockPaymentUpdateMany = jest.fn();
const mockSettlementCreate = jest.fn();
const mockSettlementUpdate = jest.fn();
const mockSettlementFindUnique = jest.fn();
const mockSettlementFindMany = jest.fn();
const mockSettlementCount = jest.fn();
const mockSessionFindUnique = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    quote: {
      findUnique: (...args: any[]) => mockQuoteFindUnique(...args),
      update: (...args: any[]) => mockQuoteUpdate(...args),
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
    merchant: {
      findUnique: (...args: any[]) => mockMerchantFindUnique(...args),
      update: (...args: any[]) => mockMerchantUpdate(...args),
    },
    payment: {
      findMany: (...args: any[]) => mockPaymentFindMany(...args),
      updateMany: (...args: any[]) => mockPaymentUpdateMany(...args),
    },
    settlement: {
      create: (...args: any[]) => mockSettlementCreate(...args),
      update: (...args: any[]) => mockSettlementUpdate(...args),
      findUnique: (...args: any[]) => mockSettlementFindUnique(...args),
      findMany: (...args: any[]) => mockSettlementFindMany(...args),
      count: (...args: any[]) => mockSettlementCount(...args),
    },
    session: {
      findUnique: (...args: any[]) => mockSessionFindUnique(...args),
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
  SettlementStatus: {
    PENDING: 'PENDING',
    PROCESSING: 'PROCESSING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    RETRYING: 'RETRYING',
  },
}));

// Setup Test App
const testApp = express();
testApp.use(express.json());
testApp.use('/api/offramp', offrampRoutes);
testApp.use('/api/merchant/settings', merchantSettingsRoutes);
testApp.use('/api/merchant/settlements', merchantSettlementsRoutes);
testApp.use(errorHandler);

describe('Stage 5 & Stage 6 API Endpoints (Integration)', () => {
  const consumerId = 'consumer_usr_123';
  const consumerToken = jwt.sign({ id: consumerId, role: 'consumer' }, JWT_SECRET);

  const merchantId = 'merchant_biz_456';
  const merchantToken = jwt.sign(
    { id: merchantId, walletAddress: 'MerchWallet...', role: 'merchant' },
    JWT_SECRET
  );

  const otherUserToken = jwt.sign({ id: 'consumer_other_999', role: 'consumer' }, JWT_SECRET);

  const testQuote = {
    id: 'quote_123',
    userId: consumerId,
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
    expiresAt: new Date(Date.now() + 60000),
    used: false,
  };

  const testBankAccount = {
    id: 'bank_123',
    userId: consumerId,
    merchantId,
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

    // Default session mock for requireAuth
    mockSessionFindUnique.mockResolvedValue({
      id: 'session_1',
      token: merchantToken,
      expiresAt: new Date(Date.now() + 3600000),
      merchant: {
        id: merchantId,
        walletAddress: 'MerchWallet...',
        businessName: 'Flux Merchant',
        email: 'merchant@fluxpay.io',
      },
    });
  });

  // ─── STAGE 5: OFF-RAMP EXECUTION ─────────────────────────────────────

  describe('POST /api/offramp/execute', () => {
    it('returns 401 without auth token', async () => {
      const res = await request(testApp)
        .post('/api/offramp/execute')
        .send({ quoteId: 'quote_123', bankAccountId: 'bank_123' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Authentication required');
    });

    it('returns 400 when quoteId is missing', async () => {
      const res = await request(testApp)
        .post('/api/offramp/execute')
        .set('Authorization', `Bearer ${consumerToken}`)
        .send({ bankAccountId: 'bank_123' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 when quote is not found', async () => {
      mockQuoteFindUnique.mockResolvedValue(null);

      const res = await request(testApp)
        .post('/api/offramp/execute')
        .set('Authorization', `Bearer ${consumerToken}`)
        .send({ quoteId: 'missing', bankAccountId: 'bank_123' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('returns 410 QUOTE_EXPIRED when quote expires', async () => {
      mockQuoteFindUnique.mockResolvedValue({
        ...testQuote,
        expiresAt: new Date(Date.now() - 5000),
      });

      const res = await request(testApp)
        .post('/api/offramp/execute')
        .set('Authorization', `Bearer ${consumerToken}`)
        .send({ quoteId: 'quote_123', bankAccountId: 'bank_123' });

      expect(res.status).toBe(410);
      expect(res.body.code).toBe('QUOTE_EXPIRED');
    });

    it('returns 409 QUOTE_ALREADY_USED when quote was already used', async () => {
      mockQuoteFindUnique.mockResolvedValue({
        ...testQuote,
        used: true,
      });

      const res = await request(testApp)
        .post('/api/offramp/execute')
        .set('Authorization', `Bearer ${consumerToken}`)
        .send({ quoteId: 'quote_123', bankAccountId: 'bank_123' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('QUOTE_ALREADY_USED');
    });

    it('returns 403 FORBIDDEN when user accesses someone elses bank account', async () => {
      mockQuoteFindUnique.mockResolvedValue(testQuote);
      mockBankAccountFindUnique.mockResolvedValue({
        ...testBankAccount,
        userId: 'other_user_id',
      });

      const res = await request(testApp)
        .post('/api/offramp/execute')
        .set('Authorization', `Bearer ${consumerToken}`)
        .send({ quoteId: 'quote_123', bankAccountId: 'bank_123' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('returns 502 PROVIDER_ERROR when Jupiter mock fails', async () => {
      process.env.MOCK_FORCE_SWAP_BUILD_FAIL = 'true';
      mockQuoteFindUnique.mockResolvedValue(testQuote);
      mockBankAccountFindUnique.mockResolvedValue(testBankAccount);
      mockTxCreate.mockResolvedValue({ id: 'tx_fail', status: 'PENDING' });

      const res = await request(testApp)
        .post('/api/offramp/execute')
        .set('Authorization', `Bearer ${consumerToken}`)
        .send({ quoteId: 'quote_123', bankAccountId: 'bank_123' });

      expect(res.status).toBe(502);
      expect(res.body.code).toBe('PROVIDER_ERROR');
    });

    it('happy path: returns 200 with AWAITING_SIGNATURE and serializedTransaction', async () => {
      mockQuoteFindUnique.mockResolvedValue(testQuote);
      mockBankAccountFindUnique.mockResolvedValue(testBankAccount);
      mockTxCreate.mockResolvedValue({ id: 'tx_123', status: 'PENDING' });
      mockQuoteUpdate.mockResolvedValue({});
      mockTxUpdate.mockResolvedValue({ id: 'tx_123', status: 'AWAITING_SIGNATURE' });

      const res = await request(testApp)
        .post('/api/offramp/execute')
        .set('Authorization', `Bearer ${consumerToken}`)
        .send({ quoteId: 'quote_123', bankAccountId: 'bank_123' });

      expect(res.status).toBe(200);
      expect(res.body.transactionId).toBe('tx_123');
      expect(res.body.status).toBe('AWAITING_SIGNATURE');
      expect(res.body.serializedTransaction).toBeDefined();
      expect(res.body.bankAccount.accountNumber).toBe('080******89');
    });
  });

  describe('POST /api/offramp/submit', () => {
    it('returns 409 INVALID_STATE_TRANSITION when transaction already COMPLETED', async () => {
      mockTxFindUnique.mockResolvedValue({
        id: 'tx_completed',
        userId: consumerId,
        status: 'COMPLETED',
      });

      const res = await request(testApp)
        .post('/api/offramp/submit')
        .set('Authorization', `Bearer ${consumerToken}`)
        .send({ transactionId: 'tx_completed', signedTransaction: 'mock_sig' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('returns 403 FORBIDDEN when user does not own the transaction', async () => {
      mockTxFindUnique.mockResolvedValue({
        id: 'tx_other',
        userId: 'other_user',
        status: 'AWAITING_SIGNATURE',
      });

      const res = await request(testApp)
        .post('/api/offramp/submit')
        .set('Authorization', `Bearer ${consumerToken}`)
        .send({ transactionId: 'tx_other', signedTransaction: 'mock_sig' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('happy path: executes swap and payout, returns 200 COMPLETED', async () => {
      mockTxFindUnique.mockResolvedValue({
        id: 'tx_happy',
        userId: consumerId,
        status: 'AWAITING_SIGNATURE',
        bankAccountId: 'bank_123',
        fiatCurrency: 'NGN',
        netAmount: '2303.39',
        provider: 'ngn-mock',
      });
      mockBankAccountFindUnique.mockResolvedValue(testBankAccount);

      const res = await request(testApp)
        .post('/api/offramp/submit')
        .set('Authorization', `Bearer ${consumerToken}`)
        .send({ transactionId: 'tx_happy', signedTransaction: 'mock_sig' });

      expect(res.status).toBe(200);
      expect(res.body.transactionId).toBe('tx_happy');
      expect(res.body.status).toBe('COMPLETED');
      expect(res.body.swapTxHash).toBeDefined();
      expect(res.body.payoutRefId).toBeDefined();
    });
  });

  describe('GET /api/offramp/transactions & :id & :id/status', () => {
    it('GET /api/offramp/transactions returns paginated list', async () => {
      mockTxFindMany.mockResolvedValue([
        {
          id: 'tx_1',
          userId: consumerId,
          status: 'COMPLETED',
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: new Date(),
        },
      ]);
      mockTxCount.mockResolvedValue(1);

      const res = await request(testApp)
        .get('/api/offramp/transactions?limit=10')
        .set('Authorization', `Bearer ${consumerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.transactions.length).toBe(1);
      expect(res.body.total).toBe(1);
    });

    it('GET /api/offramp/transactions/:id returns detail', async () => {
      mockTxFindUnique.mockResolvedValue({
        id: 'tx_1',
        userId: consumerId,
        bankAccountId: 'bank_123',
        status: 'COMPLETED',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockBankAccountFindUnique.mockResolvedValue(testBankAccount);

      const res = await request(testApp)
        .get('/api/offramp/transactions/tx_1')
        .set('Authorization', `Bearer ${consumerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('tx_1');
      expect(res.body.bankAccount?.accountNumber).toBe('080******89');
    });

    it('GET /api/offramp/transactions/:id/status returns status and step info', async () => {
      mockTxFindUnique.mockResolvedValue({
        id: 'tx_1',
        userId: consumerId,
        status: 'SWAPPING',
      });

      const res = await request(testApp)
        .get('/api/offramp/transactions/tx_1/status')
        .set('Authorization', `Bearer ${consumerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('SWAPPING');
      expect(res.body.step).toBe(4);
      expect(res.body.totalSteps).toBe(6);
      expect(res.body.isTerminal).toBe(false);
    });
  });

  // ─── STAGE 6: MERCHANT SETTLEMENT ENGINE ────────────────────────────

  describe('Merchant Settings: /api/merchant/settings/settlement', () => {
    it('GET /api/merchant/settings/settlement returns preference', async () => {
      mockMerchantFindUnique.mockResolvedValue({
        id: merchantId,
        settlementType: 'FIAT',
        settlementCurrency: 'NGN',
        defaultPayoutAccountId: 'bank_123',
      });
      mockBankAccountFindUnique.mockResolvedValue(testBankAccount);

      const res = await request(testApp)
        .get('/api/merchant/settings/settlement')
        .set('Authorization', `Bearer ${merchantToken}`);

      expect(res.status).toBe(200);
      expect(res.body.settlementType).toBe('FIAT');
      expect(res.body.settlementCurrency).toBe('NGN');
      expect(res.body.defaultPayoutAccount?.accountNumber).toBe('080******89');
    });

    it('PATCH /api/merchant/settings/settlement validates settlementType', async () => {
      const res = await request(testApp)
        .patch('/api/merchant/settings/settlement')
        .set('Authorization', `Bearer ${merchantToken}`)
        .send({ settlementType: 'INVALID' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('PATCH /api/merchant/settings/settlement updates to FIAT', async () => {
      mockMerchantFindUnique.mockResolvedValue({ id: merchantId });
      mockBankAccountFindUnique.mockResolvedValue(testBankAccount);
      mockMerchantUpdate.mockResolvedValue({});

      const res = await request(testApp)
        .patch('/api/merchant/settings/settlement')
        .set('Authorization', `Bearer ${merchantToken}`)
        .send({
          settlementType: 'FIAT',
          settlementCurrency: 'NGN',
          defaultPayoutAccountId: 'bank_123',
        });

      expect(res.status).toBe(200);
      expect(res.body.settlementType).toBe('FIAT');
      expect(res.body.settlementCurrency).toBe('NGN');
      expect(res.body.defaultPayoutAccount.accountName).toBe('UDUAK GABRIEL AKPAN');
    });
  });

  describe('Merchant Settlements: /api/merchant/settlements', () => {
    it('POST /api/merchant/settlements/trigger triggers fiat settlement', async () => {
      mockMerchantFindUnique.mockResolvedValue({
        id: merchantId,
        settlementType: 'FIAT',
        settlementCurrency: 'NGN',
        defaultPayoutAccountId: 'bank_123',
      });
      mockBankAccountFindUnique.mockResolvedValue(testBankAccount);
      mockPaymentFindMany.mockResolvedValue([
        { id: 'pay_1', amount: 100, status: 'COMPLETED', settled: false },
      ]);
      mockSettlementCreate.mockResolvedValue({
        id: 'settle_123',
        status: 'PENDING',
      });
      mockSettlementUpdate.mockResolvedValue({
        id: 'settle_123',
        status: 'COMPLETED',
        createdAt: new Date(),
        updatedAt: new Date(),
        settledAt: new Date(),
      });
      mockPaymentUpdateMany.mockResolvedValue({});

      const res = await request(testApp)
        .post('/api/merchant/settlements/trigger')
        .set('Authorization', `Bearer ${merchantToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('settle_123');
      expect(res.body.status).toBe('COMPLETED');
    });

    it('GET /api/merchant/settlements lists settlements', async () => {
      mockSettlementFindMany.mockResolvedValue([
        {
          id: 'settle_123',
          merchantId,
          status: 'COMPLETED',
          currency: 'NGN',
          grossAmount: '100.00',
          fiatAmount: '152300.00',
          fxRate: '1523',
          fee: '761.50',
          netAmount: '151538.50',
          provider: 'ngn-mock',
          paymentIds: ['pay_1'],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      mockSettlementCount.mockResolvedValue(1);

      const res = await request(testApp)
        .get('/api/merchant/settlements')
        .set('Authorization', `Bearer ${merchantToken}`);

      expect(res.status).toBe(200);
      expect(res.body.settlements.length).toBe(1);
      expect(res.body.settlements[0].paymentCount).toBe(1);
    });

    it('GET /api/merchant/settlements/:id returns full detail', async () => {
      mockSettlementFindUnique.mockResolvedValue({
        id: 'settle_123',
        merchantId,
        status: 'COMPLETED',
        currency: 'NGN',
        grossAmount: '100.00',
        fiatAmount: '152300.00',
        fxRate: '1523',
        fee: '761.50',
        netAmount: '151538.50',
        provider: 'ngn-mock',
        bankAccountId: 'bank_123',
        paymentIds: ['pay_1'],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockPaymentFindMany.mockResolvedValue([
        { id: 'pay_1', amount: 100, status: 'COMPLETED' },
      ]);
      mockBankAccountFindUnique.mockResolvedValue(testBankAccount);

      const res = await request(testApp)
        .get('/api/merchant/settlements/settle_123')
        .set('Authorization', `Bearer ${merchantToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('settle_123');
      expect(res.body.bankAccount?.accountNumber).toBe('080******89');
      expect(res.body.payments.length).toBe(1);
    });
  });
});
