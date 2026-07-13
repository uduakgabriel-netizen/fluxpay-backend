import { Request, Response } from 'express';
import { requireAuth } from '../../middleware/auth.middleware';
import * as jwtConfig from '../../utils/jwt';
import { PrismaClient } from '@prisma/client';

const mockPrismaDelete = jest.fn();
const mockPrismaFindUnique = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    session: {
      findUnique: (...args: any[]) => mockPrismaFindUnique(...args),
      delete: (...args: any[]) => mockPrismaDelete(...args),
    },
  })),
}));

jest.mock('../../utils/jwt', () => ({
  verifyToken: jest.fn(),
}));

describe('Auth Middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock;

  beforeEach(() => {
    req = { headers: {} };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
    jest.clearAllMocks();
  });

  it('fails if no auth header', async () => {
    await requireAuth(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('fails if invalid token', async () => {
    req.headers!.authorization = 'Bearer invalid';
    (jwtConfig.verifyToken as jest.Mock).mockReturnValue(null);
    await requireAuth(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('fails if session expired', async () => {
    req.headers!.authorization = 'Bearer valid';
    (jwtConfig.verifyToken as jest.Mock).mockReturnValue({ id: '1' });
    mockPrismaFindUnique.mockResolvedValue({
      id: 'session1',
      expiresAt: new Date(Date.now() - 10000), // past
      merchant: { id: 'merch1' }
    });

    await requireAuth(req as any, res as any, next);
    expect(mockPrismaDelete).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('succeeds and attaches merchant', async () => {
    req.headers!.authorization = 'Bearer valid';
    (jwtConfig.verifyToken as jest.Mock).mockReturnValue({ id: '1' });
    mockPrismaFindUnique.mockResolvedValue({
      id: 'session1',
      expiresAt: new Date(Date.now() + 10000), // future
      merchant: { id: 'merch1', email: 'test@example.com' }
    });

    await requireAuth(req as any, res as any, next);
    expect(next).toHaveBeenCalled();
    expect((req as any).merchant.id).toBe('merch1');
  });
});
