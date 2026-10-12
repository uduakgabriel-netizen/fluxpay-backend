import request from 'supertest';
import express from 'express';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import jwt from 'jsonwebtoken';
import consumerAuthRoutes from '../../routes/consumerAuth.routes';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me';

// Mock Prisma for user lookup and upsert in API integration tests
const mockPrismaUpsert = jest.fn();
const mockPrismaFindUnique = jest.fn();
const mockPrismaDeleteMany = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    user: {
      upsert: (...args: any[]) => mockPrismaUpsert(...args),
      findUnique: (...args: any[]) => mockPrismaFindUnique(...args),
    },
    consumerNonce: {
      upsert: (...args: any[]) => mockPrismaUpsert(...args),
      findUnique: (...args: any[]) => mockPrismaFindUnique(...args),
      deleteMany: (...args: any[]) => mockPrismaDeleteMany(...args),
    },
  })),
}));

const testApp = express();
testApp.use(express.json());
testApp.use('/api/auth/consumer', consumerAuthRoutes);

describe('Consumer Auth API Endpoints (Integration)', () => {
  const testKeypair = Keypair.generate();
  const testWallet = testKeypair.publicKey.toBase58();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/auth/consumer/nonce', () => {
    it('returns 400 when walletAddress is missing', async () => {
      const res = await request(testApp)
        .post('/api/auth/consumer/nonce')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'walletAddress is required' });
    });

    it('returns 400 when walletAddress is invalid', async () => {
      const res = await request(testApp)
        .post('/api/auth/consumer/nonce')
        .send({ walletAddress: 'not-a-valid-solana-key' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid wallet address' });
    });

    it('returns 200 with nonce and 5-min expiresAt on valid wallet', async () => {
      const res = await request(testApp)
        .post('/api/auth/consumer/nonce')
        .send({ walletAddress: testWallet });

      expect(res.status).toBe(200);
      expect(res.body.nonce).toBeDefined();
      expect(res.body.nonce.length).toBe(64);
      expect(res.body.expiresAt).toBeDefined();
    });
  });

  describe('POST /api/auth/consumer/verify', () => {
    it('returns 400 if walletAddress or signature is missing', async () => {
      const res1 = await request(testApp)
        .post('/api/auth/consumer/verify')
        .send({ signature: 'xyz' });
      expect(res1.status).toBe(400);
      expect(res1.body).toEqual({ error: 'walletAddress is required' });

      const res2 = await request(testApp)
        .post('/api/auth/consumer/verify')
        .send({ walletAddress: testWallet });
      expect(res2.status).toBe(400);
      expect(res2.body).toEqual({ error: 'signature is required' });
    });

    it('returns 401 if nonce expired or not found', async () => {
      const freshWallet = Keypair.generate().publicKey.toBase58();
      const res = await request(testApp)
        .post('/api/auth/consumer/verify')
        .send({
          walletAddress: freshWallet,
          signature: bs58.encode(new Uint8Array(64)),
        });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Nonce expired or not found' });
    });

    it('returns 401 if signature is invalid', async () => {
      // 1. Get nonce
      await request(testApp)
        .post('/api/auth/consumer/nonce')
        .send({ walletAddress: testWallet });

      // 2. Send invalid signature
      const res = await request(testApp)
        .post('/api/auth/consumer/verify')
        .send({
          walletAddress: testWallet,
          signature: bs58.encode(new Uint8Array(64)),
        });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid signature' });
    });

    it('verifies valid signature, creates consumer, returns JWT and user', async () => {
      // 1. Request nonce
      const nonceRes = await request(testApp)
        .post('/api/auth/consumer/nonce')
        .send({ walletAddress: testWallet });
      const nonce = nonceRes.body.nonce;

      // 2. Sign nonce
      const sigBytes = nacl.sign.detached(
        new TextEncoder().encode(nonce),
        testKeypair.secretKey
      );
      const signature = bs58.encode(sigBytes);

      // 3. Mock user upsert
      const mockUser = {
        id: 'usr_cuid_test_999',
        walletAddress: testWallet,
        createdAt: new Date('2026-09-27T03:00:00Z'),
        updatedAt: new Date(),
      };
      mockPrismaUpsert.mockResolvedValue(mockUser);

      // 4. Verify
      const verifyRes = await request(testApp)
        .post('/api/auth/consumer/verify')
        .send({
          walletAddress: testWallet,
          signature,
        });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.token).toBeDefined();
      expect(verifyRes.body.user).toEqual({
        id: 'usr_cuid_test_999',
        walletAddress: testWallet,
      });

      // Verify JWT payload
      const decoded = jwt.decode(verifyRes.body.token) as any;
      expect(decoded.id).toBe('usr_cuid_test_999');
      expect(decoded.role).toBe('consumer');
      expect(decoded.walletAddress).toBeUndefined();
    });
  });

  describe('GET /api/auth/consumer/me', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(testApp).get('/api/auth/consumer/me');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Authentication required' });
    });

    it('returns 403 when a merchant token is used', async () => {
      const merchantToken = jwt.sign(
        { id: 'merch_123', role: 'merchant' },
        JWT_SECRET,
        { expiresIn: '1h' }
      );

      const res = await request(testApp)
        .get('/api/auth/consumer/me')
        .set('Authorization', `Bearer ${merchantToken}`);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Consumer access only' });
    });

    it('returns 200 with user profile when valid consumer token is provided', async () => {
      const consumerToken = jwt.sign(
        { id: 'usr_cuid_test_999', role: 'consumer' },
        JWT_SECRET,
        { expiresIn: '1h' }
      );

      mockPrismaFindUnique.mockResolvedValue({
        id: 'usr_cuid_test_999',
        walletAddress: testWallet,
        createdAt: new Date('2026-09-27T03:00:00Z'),
      });

      const res = await request(testApp)
        .get('/api/auth/consumer/me')
        .set('Authorization', `Bearer ${consumerToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: 'usr_cuid_test_999',
        walletAddress: testWallet,
        createdAt: '2026-09-27T03:00:00.000Z',
      });
    });
  });
});
