import { Request, Response } from 'express';
import { createSession } from '../../controllers/checkout.controller';
import { createHash } from 'crypto';

const mockMerchantFindFirst = jest.fn();
const mockApiKeyFindUnique = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    merchant: {
      findFirst: (...args: any[]) => mockMerchantFindFirst(...args),
      findUnique: jest.fn(),
    },
    apiKey: {
      findUnique: (...args: any[]) => mockApiKeyFindUnique(...args),
      update: jest.fn().mockReturnValue(Promise.resolve()),
    },
    checkoutSession: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({
        id: data.id,
        merchantId: data.merchantId,
        orderId: data.orderId,
        amount: data.amount,
        token: data.token,
        status: data.status,
        expiresAt: data.expiresAt,
      })),
    },
  })),
}));

jest.mock('../../services/cache.service', () => ({
  cacheService: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('POST /api/checkout/sessions - API Key Authentication', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;

  beforeEach(() => {
    req = {
      headers: {},
      body: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    jest.clearAllMocks();
  });

  it('fails with 401 { error: "Invalid API key" } when no API key is provided', async () => {
    req.body = {
      amount: 1.0,
      token: 'USDC',
    };

    await createSession(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
  });

  it('fails with 401 { error: "Invalid API key" } when invalid API key is provided', async () => {
    req.headers = {
      'x-api-key': 'sk_test_nonexistent_key_12345',
    };
    req.body = {
      amount: 1.0,
      token: 'USDC',
    };

    mockMerchantFindFirst.mockResolvedValue(null);
    mockApiKeyFindUnique.mockResolvedValue(null);

    await createSession(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
  });

  it('resolves merchant by apiKeyHash and creates session with no merchantId in request body', async () => {
    const testKey = 'sk_test_valid_merchant_key_abc';
    const testHash = createHash('sha256').update(testKey).digest('hex');

    req.headers = {
      'x-api-key': testKey,
    };
    req.body = {
      amount: 10.5,
      token: 'USDC',
      orderId: 'TEST-ORDER-123',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    };

    const mockMerchant = {
      id: 'merchant_resolved_from_hash',
      apiKeyHash: testHash,
      businessName: 'Acme Shoes',
      walletAddress: '7J5tPd33wXDFVcFvgPJdhiTrG3qxvJbCp1JiQZET3NFh',
    };

    mockMerchantFindFirst.mockResolvedValue(mockMerchant);

    await createSession(req as Request, res as Response);

    // Verified: merchant looked up by apiKeyHash
    expect(mockMerchantFindFirst).toHaveBeenCalledWith({
      where: { apiKeyHash: testHash },
    });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.any(String),
        checkoutUrl: expect.stringContaining('/pay/'),
        amount: 10.5,
        token: 'USDC',
      })
    );
  });
});
