import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import jwt from 'jsonwebtoken';
import * as consumerAuthService from '../../services/consumerAuth.service';
import {
  generateNonceString,
  isValidSolanaAddress,
  storeConsumerNonce,
  getConsumerNonce,
  deleteConsumerNonce,
} from '../../utils/consumerNonce';

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

describe('Consumer Auth System', () => {
  const testKeypair = Keypair.generate();
  const testWallet = testKeypair.publicKey.toBase58();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Address Validation', () => {
    it('validates a correct Solana public key on-curve', () => {
      expect(isValidSolanaAddress(testWallet)).toBe(true);
    });

    it('rejects an invalid base58 address', () => {
      expect(isValidSolanaAddress('InvalidAddress123')).toBe(false);
      expect(isValidSolanaAddress('')).toBe(false);
      expect(isValidSolanaAddress(null as any)).toBe(false);
    });
  });

  describe('Nonce Generation and Storage', () => {
    it('generates a 32-byte (64 hex chars) nonce with 5-min TTL', async () => {
      const result = await consumerAuthService.generateConsumerNonce(testWallet);
      expect(result.nonce).toBeDefined();
      expect(result.nonce.length).toBe(64); // 32 bytes hex
      expect(result.expiresAt).toBeDefined();

      const expiry = new Date(result.expiresAt).getTime();
      const now = Date.now();
      // Should expire approximately 5 minutes (300,000 ms) from now
      expect(expiry - now).toBeGreaterThan(290000);
      expect(expiry - now).toBeLessThanOrEqual(300000);

      // Verify stored
      const stored = await getConsumerNonce(testWallet);
      expect(stored).toBe(result.nonce);
    });

    it('throws 400 for invalid wallet address on nonce generation', async () => {
      await expect(
        consumerAuthService.generateConsumerNonce('invalid-wallet')
      ).rejects.toMatchObject({
        statusCode: 400,
        message: 'Invalid wallet address',
      });
    });
  });

  describe('Signature Verification & Login', () => {
    it('successfully verifies a signed nonce, creates user, and returns JWT with role consumer', async () => {
      // 1. Generate nonce
      const { nonce } = await consumerAuthService.generateConsumerNonce(testWallet);

      // 2. Sign nonce using tweetnacl detached signature
      const messageBytes = new TextEncoder().encode(nonce);
      const signatureBytes = nacl.sign.detached(messageBytes, testKeypair.secretKey);
      const signatureBase58 = bs58.encode(signatureBytes);

      // Mock user upsert
      const mockUser = {
        id: 'usr_cuid_test_123',
        walletAddress: testWallet,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPrismaUpsert.mockResolvedValue(mockUser);

      // 3. Verify
      const result = await consumerAuthService.verifyConsumerSignature(
        testWallet,
        signatureBase58
      );

      expect(result.token).toBeDefined();
      expect(result.user).toEqual({
        id: 'usr_cuid_test_123',
        walletAddress: testWallet,
      });

      // Decode JWT to verify payload
      const decoded = jwt.decode(result.token) as any;
      expect(decoded.id).toBe('usr_cuid_test_123');
      expect(decoded.role).toBe('consumer');
      // Must NOT contain walletAddress in JWT (per Part 6 requirement)
      expect(decoded.walletAddress).toBeUndefined();

      // 4. Ensure nonce is single-use: subsequent verification with same nonce fails
      await expect(
        consumerAuthService.verifyConsumerSignature(testWallet, signatureBase58)
      ).rejects.toMatchObject({
        statusCode: 401,
        message: 'Nonce expired or not found',
      });
    });

    it('rejects an invalid signature with 401', async () => {
      const { nonce } = await consumerAuthService.generateConsumerNonce(testWallet);

      // Sign with a DIFFERENT keypair
      const wrongKeypair = Keypair.generate();
      const messageBytes = new TextEncoder().encode(nonce);
      const wrongSignatureBytes = nacl.sign.detached(messageBytes, wrongKeypair.secretKey);
      const wrongSignatureBase58 = bs58.encode(wrongSignatureBytes);

      await expect(
        consumerAuthService.verifyConsumerSignature(testWallet, wrongSignatureBase58)
      ).rejects.toMatchObject({
        statusCode: 401,
        message: 'Invalid signature',
      });
    });

    it('rejects if nonce not found or already consumed', async () => {
      const freshWallet = Keypair.generate().publicKey.toBase58();
      const dummySig = bs58.encode(new Uint8Array(64));
      await expect(
        consumerAuthService.verifyConsumerSignature(freshWallet, dummySig)
      ).rejects.toThrow('Nonce expired or not found');
    });
  });

  describe('Consumer Profile Lookup', () => {
    it('returns consumer profile', async () => {
      const mockDate = new Date();
      mockPrismaFindUnique.mockResolvedValue({
        id: 'usr_abc',
        walletAddress: testWallet,
        createdAt: mockDate,
      });

      const profile = await consumerAuthService.getConsumerProfile('usr_abc');
      expect(profile).toEqual({
        id: 'usr_abc',
        walletAddress: testWallet,
        createdAt: mockDate.toISOString(),
      });
    });

    it('throws 404 if user not found', async () => {
      mockPrismaFindUnique.mockResolvedValue(null);
      await expect(
        consumerAuthService.getConsumerProfile('non-existent')
      ).rejects.toMatchObject({
        statusCode: 404,
        message: 'User not found',
      });
    });
  });
});
