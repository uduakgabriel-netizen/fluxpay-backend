import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

import consumerAuthRoutes from '../../routes/consumerAuth.routes';
import assetsRoutes from '../../routes/assets.routes';
import quoteRoutes from '../../routes/quote.routes';
import offrampRoutes from '../../routes/offramp.routes';
import payoutAccountsRoutes from '../../routes/payoutAccounts.routes';
import merchantSettingsRoutes from '../../routes/merchantSettings.routes';
import merchantSettlementsRoutes from '../../routes/merchantSettlements.routes';
import webhooksRoutes from '../../routes/webhooks.routes';
import { getSystemHealth, getAdminMetrics } from '../../controllers/monitoring.controller';
import { requireAdminAuth } from '../../middleware/adminAuth.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { errorHandler } from '../../middleware/errorHandler';

const JWT_SECRET = 'test_jwt_secret_flow_12345';
const HELIUS_SECRET = 'test_helius_secret_32bytes_hex_12345';
const NGN_SECRET = 'test_ngn_secret_32bytes_hex_12345';

process.env.USE_MOCK_PROVIDERS = 'true';
process.env.JWT_SECRET = JWT_SECRET;
process.env.HELIUS_WEBHOOK_SECRET = HELIUS_SECRET;
process.env.NGN_WEBHOOK_SECRET = NGN_SECRET;

// Mock Prisma
const mockFindUnique = jest.fn();
const mockFindMany = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockUpsert = jest.fn();
const mockCount = jest.fn();
const mockUpdateMany = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    user: {
      findUnique: (...args: any[]) => mockFindUnique(...args),
      upsert: (...args: any[]) => mockUpsert(...args),
    },
    session: {
      findUnique: (...args: any[]) => mockFindUnique(...args),
      delete: (...args: any[]) => Promise.resolve({ id: 'deleted_session' }),
    },
    token: {
      findMany: (...args: any[]) => mockFindMany(...args),
      count: (...args: any[]) => mockCount(...args),
    },
    merchant: {
      findUnique: (...args: any[]) => mockFindUnique(...args),
      update: (...args: any[]) => mockUpdate(...args),
    },
    quote: {
      create: (...args: any[]) => mockCreate(...args),
      findUnique: (...args: any[]) => mockFindUnique(...args),
      update: (...args: any[]) => mockUpdate(...args),
    },
    bankAccount: {
      create: (...args: any[]) => mockCreate(...args),
      findUnique: (...args: any[]) => mockFindUnique(...args),
      findMany: (...args: any[]) => mockFindMany(...args),
      update: (...args: any[]) => mockUpdate(...args),
      updateMany: (...args: any[]) => mockUpdateMany(...args),
      count: (...args: any[]) => mockCount(...args),
    },
    offRampTransaction: {
      create: (...args: any[]) => mockCreate(...args),
      findUnique: (...args: any[]) => mockFindUnique(...args),
      findMany: (...args: any[]) => mockFindMany(...args),
      update: (...args: any[]) => mockUpdate(...args),
      count: (...args: any[]) => mockCount(...args),
    },
    payment: {
      findMany: (...args: any[]) => mockPaymentFindMany(...args),
      updateMany: (...args: any[]) => mockPaymentUpdateMany(...args),
      findUnique: (...args: any[]) => mockFindUnique(...args),
      update: (...args: any[]) => mockUpdate(...args),
    },
    settlement: {
      create: (...args: any[]) => mockCreate(...args),
      findUnique: (...args: any[]) => mockFindUnique(...args),
      findMany: (...args: any[]) => mockFindMany(...args),
      update: (...args: any[]) => mockUpdate(...args),
      count: (...args: any[]) => mockCount(...args),
    },
    webhookLog: {
      create: (...args: any[]) => mockCreate(...args),
      findUnique: (...args: any[]) => mockFindUnique(...args),
      count: (...args: any[]) => mockCount(...args),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ 1: 1 }]),
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
  SettlementType: {
    CRYPTO: 'CRYPTO',
    FIAT: 'FIAT',
  },
  PaymentStatus: {
    PENDING: 'PENDING',
    DETECTED: 'DETECTED',
    CONFIRMED: 'CONFIRMED',
    FAILED: 'FAILED',
    SETTLED: 'SETTLED',
  },
}));

const mockPaymentFindMany = jest.fn();
const mockPaymentUpdateMany = jest.fn();

describe('Stage 7 & Stage 8 End-to-End Integration Flow', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(
      express.json({
        verify: (req: any, _res, buf) => {
          req.rawBody = buf;
        },
      })
    );

    // Monitoring
    app.get('/api/health', asyncHandler(getSystemHealth));
    app.get('/api/admin/metrics', requireAdminAuth, asyncHandler(getAdminMetrics));

    // Routes
    app.use('/api/auth/consumer', consumerAuthRoutes);
    app.use('/api/assets', assetsRoutes);
    app.use('/api/offramp', quoteRoutes);
    app.use('/api/offramp', offrampRoutes);
    app.use('/api/payout-accounts', payoutAccountsRoutes);
    app.use('/api/merchant/settings', merchantSettingsRoutes);
    app.use('/api/merchant/settlements', merchantSettlementsRoutes);
    app.use('/api/webhooks', webhooksRoutes);

    app.use(errorHandler);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Stage 8 Consumer Flow: BONK -> NGN -> Bank Payout', () => {
    it('executes full consumer offramp journey from wallet connect to completed payout', async () => {
      // Step 1.1: Generate keypair and request nonce
      const keypair = nacl.sign.keyPair();
      const walletAddress = bs58.encode(keypair.publicKey);

      const nonceRes = await request(app)
        .post('/api/auth/consumer/nonce')
        .send({ walletAddress });

      expect(nonceRes.status).toBe(200);
      expect(nonceRes.body.nonce).toBeDefined();
      const nonce = nonceRes.body.nonce;

      // Step 1.2: Sign nonce with tweetnacl ed25519 keypair and verify
      const nonceBytes = new TextEncoder().encode(nonce);
      const signatureBytes = nacl.sign.detached(nonceBytes, keypair.secretKey);
      const signature = bs58.encode(signatureBytes);

      mockUpsert.mockResolvedValueOnce({
        id: 'consumer_user_123',
        walletAddress,
        createdAt: new Date(),
      });

      const verifyRes = await request(app)
        .post('/api/auth/consumer/verify')
        .send({ walletAddress, signature });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.token).toBeDefined();
      const consumerJwt = verifyRes.body.token;

      // Step 1.3: Consumer fetches sellable tokens (verify BONK is listed)
      const tokensRes = await request(app).get('/api/assets/sellable');
      expect(tokensRes.status).toBe(200);
      expect(tokensRes.body.tokens).toBeDefined();
      const bonkToken = tokensRes.body.tokens.find((t: any) => t.symbol === 'BONK');
      expect(bonkToken).toBeDefined();
      expect(bonkToken.symbol).toBe('BONK');

      // Step 1.4: Consumer requests quote for 10,000 BONK to NGN
      mockCreate.mockImplementation(({ data }: any) => {
        return Promise.resolve({
          id: 'quote_bonk_123',
          ...data,
          expiresAt: new Date(Date.now() + 60000),
          used: false,
        });
      });

      const quoteRes = await request(app)
        .post('/api/offramp/quote')
        .set('Authorization', `Bearer ${consumerJwt}`)
        .send({
          sourceToken: 'BONK',
          sourceMint: bonkToken.mint,
          sourceAmount: '10000',
          fiatCurrency: 'NGN',
        });

      expect(quoteRes.status).toBe(200);
      expect(quoteRes.body.quoteId).toBeDefined();
      const quoteId = quoteRes.body.quoteId;

      // Step 1.5: Consumer adds and verifies an OPay payout bank account
      const bankAccountFixture = {
        id: 'bank_acc_consumer_1',
        userId: 'consumer_user_123',
        bankName: 'OPay',
        bankCode: '999992',
        accountNumber: '0801234567',
        accountName: 'UDUAK GABRIEL AKPAN',
        currency: 'NGN',
        isVerified: true,
        isDefault: true,
      };
      mockCreate.mockResolvedValueOnce(bankAccountFixture);

      const addBankRes = await request(app)
        .post('/api/payout-accounts')
        .set('Authorization', `Bearer ${consumerJwt}`)
        .send({
          bankName: 'OPay',
          bankCode: '999992',
          accountNumber: '0801234567',
          accountName: 'UDUAK GABRIEL AKPAN',
          currency: 'NGN',
          setDefault: true,
        });

      expect(addBankRes.status).toBe(201);
      const bankAccountId = addBankRes.body.id;

      // Step 1.6: Execute off-ramp
      const quoteFixture = {
        id: quoteId,
        userId: 'consumer_user_123',
        sourceToken: 'BONK',
        sourceMint: bonkToken.mint,
        sourceAmount: '10000',
        intermediateToken: 'USDC',
        intermediateAmount: '10.00',
        fiatCurrency: 'NGN',
        fiatAmount: '15230',
        rate: '1.523',
        fee: '152',
        networkFee: '12',
        netAmount: '15066',
        expiresAt: new Date(Date.now() + 60000),
        used: false,
      };

      bankAccountFixture.id = bankAccountId;

      mockFindUnique.mockImplementation(({ where }: any) => {
        if (where?.id === quoteId) return Promise.resolve(quoteFixture);
        if (where?.id === bankAccountId) return Promise.resolve(bankAccountFixture);
        return Promise.resolve(null);
      });

      const txFixture = {
        id: 'tx_offramp_bonk_999',
        userId: 'consumer_user_123',
        quoteId: quoteFixture.id,
        bankAccountId: bankAccountId,
        sourceToken: 'BONK',
        sourceAmount: '10000',
        intermediateToken: 'USDC',
        intermediateAmount: '10.00',
        fiatCurrency: 'NGN',
        fiatAmount: '15230',
        rate: '1.523',
        fee: '152',
        networkFee: '12',
        netAmount: '15066',
        status: 'AWAITING_SIGNATURE',
        provider: 'ngn-mock',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockCreate.mockResolvedValueOnce(txFixture);

      const execRes = await request(app)
        .post('/api/offramp/execute')
        .set('Authorization', `Bearer ${consumerJwt}`)
        .send({
          quoteId: quoteFixture.id,
          bankAccountId: bankAccountId,
        });

      expect(execRes.status).toBe(200);
      expect(execRes.body.transactionId).toBeDefined();
      expect(execRes.body.status).toBe('AWAITING_SIGNATURE');

      // Step 1.7: Submit signed transaction
      const signedTx = 'base64_encoded_signed_solana_tx_mock_12345';
      const completedTxFixture = {
        ...txFixture,
        status: 'COMPLETED',
        swapTxHash: 'mock_tx_hash_solana_777',
        payoutRefId: 'mock_payout_ngn_888',
        completedAt: new Date(),
      };
      mockFindUnique.mockImplementation(({ where }: any) => {
        if (where?.id === txFixture.id) return Promise.resolve(txFixture);
        return Promise.resolve(null);
      });
      mockUpdate.mockResolvedValue(completedTxFixture);

      const submitRes = await request(app)
        .post('/api/offramp/submit')
        .set('Authorization', `Bearer ${consumerJwt}`)
        .send({
          transactionId: txFixture.id,
          signedTransaction: signedTx,
        });

      expect(submitRes.status).toBe(200);
      expect(submitRes.body.status).toBe('COMPLETED');
      expect(submitRes.body.swapTxHash).toBeDefined();

      // Step 1.8: Poll status
      mockFindUnique.mockResolvedValueOnce(completedTxFixture);
      const statusRes = await request(app)
        .get(`/api/offramp/transactions/${txFixture.id}/status`)
        .set('Authorization', `Bearer ${consumerJwt}`);

      expect(statusRes.status).toBe(200);
      expect(statusRes.body.step).toBe(6);
      expect(statusRes.body.isTerminal).toBe(true);
      expect(statusRes.body.status).toBe('COMPLETED');
    });
  });

  describe('2. Stage 8 Merchant Flow: Fiat Settlement Settings & Manual Batch Trigger', () => {
    it('allows merchant to configure FIAT + NGN preference and trigger on-demand settlement', async () => {
      const merchantId = 'merchant_uuid_101';
      const merchantJwt = jwt.sign(
        { id: merchantId, email: 'merchant@fluxpay.io', role: 'merchant' },
        JWT_SECRET,
        { expiresIn: '1h' }
      );

      const merchantFixture = {
        id: merchantId,
        settlementType: 'FIAT',
        settlementCurrency: 'NGN',
        defaultPayoutAccountId: 'bank_acc_merchant_1',
      };

      const sessionFixture = {
        id: 'session_merchant_1',
        token: merchantJwt,
        expiresAt: new Date(Date.now() + 86400000),
        merchant: {
          id: merchantId,
          walletAddress: 'merchant_wallet_123',
          email: 'merchant@fluxpay.io',
          businessName: 'Flux Merchant',
        },
      };

      mockFindUnique.mockImplementation(({ where }: any) => {
        if (where?.token) return Promise.resolve(sessionFixture);
        if (where?.id === merchantId) return Promise.resolve(merchantFixture);
        if (where?.id === 'bank_acc_merchant_1') {
          return Promise.resolve({
            id: 'bank_acc_merchant_1',
            merchantId,
            bankName: 'Guaranty Trust Bank (GTBank)',
            accountNumber: '0123456789',
            currency: 'NGN',
            isVerified: true,
          });
        }
        return Promise.resolve(null);
      });
      mockUpdate.mockResolvedValue(merchantFixture);

      // 2.1 Update settings
      const patchRes = await request(app)
        .patch('/api/merchant/settings/settlement')
        .set('Authorization', `Bearer ${merchantJwt}`)
        .send({
          settlementType: 'FIAT',
          settlementCurrency: 'NGN',
          defaultPayoutAccountId: 'bank_acc_merchant_1',
        });

      expect(patchRes.status).toBe(200);
      expect(patchRes.body.settlementType).toBe('FIAT');
      expect(patchRes.body.settlementCurrency).toBe('NGN');

      // 2.2 Trigger settlement
      const confirmedPayments = [
        { id: 'p1', merchantId, amount: 2.0, status: 'CONFIRMED', settled: false },
        { id: 'p2', merchantId, amount: 3.0, status: 'CONFIRMED', settled: false },
      ];
      mockPaymentFindMany.mockResolvedValueOnce(confirmedPayments);

      const settlementFixture = {
        id: 'settlement_batch_555',
        merchantId,
        currency: 'NGN',
        grossAmount: '750000',
        fee: '7500',
        netAmount: '742488',
        fxRate: '150000',
        status: 'COMPLETED',
        provider: 'ngn-mock',
        paymentCount: 2,
        settledAt: new Date(),
      };
      mockCreate.mockResolvedValueOnce(settlementFixture);
      mockUpdate.mockResolvedValueOnce(settlementFixture);
      mockPaymentUpdateMany.mockResolvedValueOnce({ count: 2 });

      const triggerRes = await request(app)
        .post('/api/merchant/settlements/trigger')
        .set('Authorization', `Bearer ${merchantJwt}`)
        .send({});

      expect(triggerRes.status).toBe(200);
      expect(triggerRes.body.status).toBe('COMPLETED');
    });
  });

  describe('3. Stage 7 Monitoring & Webhook Endpoints', () => {
    it('returns healthy system status from GET /api/health', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.services.database).toBe('connected');
      expect(res.body.version).toBe('1.0.0');
    });

    it('requires admin authorization for GET /api/admin/metrics', async () => {
      // Unauthenticated
      const unauthRes = await request(app).get('/api/admin/metrics');
      expect(unauthRes.status).toBe(401);

      // Authenticated admin
      const adminToken = jwt.sign({ id: 'admin_1', role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
      mockCount.mockResolvedValue(10);
      const authRes = await request(app)
        .get('/api/admin/metrics')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(authRes.status).toBe(200);
      expect(authRes.body.transactions).toBeDefined();
      expect(authRes.body.settlements).toBeDefined();
      expect(authRes.body.webhooks).toBeDefined();
      expect(authRes.body.wallet).toBeDefined();
    });

    it('verifies HMAC signature and processes incoming Helius webhook', async () => {
      const payload = [
        {
          signature: 'helius_tx_hash_abc_123',
          type: 'SWAP',
          events: {},
        },
      ];
      const rawBody = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha256', HELIUS_SECRET)
        .update(rawBody)
        .digest('hex');

      mockFindUnique.mockResolvedValue(null);
      mockCreate.mockResolvedValue({ id: 'log_1' });

      const res = await request(app)
        .post('/api/webhooks/helius')
        .set('Content-Type', 'application/json')
        .set('X-Helius-Signature', signature)
        .send(rawBody);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
    });

    it('rejects webhook with invalid HMAC signature with 401', async () => {
      const payload = { event: 'payout.completed' };
      const rawBody = JSON.stringify(payload);

      const res = await request(app)
        .post('/api/webhooks/ngn')
        .set('Content-Type', 'application/json')
        .set('X-Webhook-Signature', 'invalid_signature_hex')
        .send(rawBody);

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Invalid webhook signature/i);
    });
  });
});
