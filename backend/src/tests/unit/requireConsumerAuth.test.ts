import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { requireConsumerAuth } from '../../middleware/requireConsumerAuth';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-change-me';

describe('requireConsumerAuth Middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock;

  beforeEach(() => {
    req = { headers: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  it('returns 401 if no Authorization header provided', () => {
    requireConsumerAuth(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 if Authorization header is not Bearer', () => {
    req.headers = { authorization: 'Basic dXNlcjpwYXNz' };
    requireConsumerAuth(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
  });

  it('returns 401 if token is invalid', () => {
    req.headers = { authorization: 'Bearer invalid-token-xyz' };
    requireConsumerAuth(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
  });

  it('returns 401 if token is expired', () => {
    const expiredToken = jwt.sign(
      { id: 'usr_123', role: 'consumer' },
      JWT_SECRET,
      { expiresIn: '-1s' }
    );
    req.headers = { authorization: `Bearer ${expiredToken}` };
    requireConsumerAuth(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Session expired. Please sign in again',
    });
  });

  it('returns 403 if role is "merchant" (merchants cannot access consumer routes)', () => {
    const merchantToken = jwt.sign(
      { id: 'merch_123', role: 'merchant' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    req.headers = { authorization: `Bearer ${merchantToken}` };
    requireConsumerAuth(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Consumer access only' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 if role is missing', () => {
    const noRoleToken = jwt.sign(
      { id: 'usr_123' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    req.headers = { authorization: `Bearer ${noRoleToken}` };
    requireConsumerAuth(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Consumer access only' });
  });

  it('succeeds and attaches req.user when role is "consumer"', () => {
    const consumerToken = jwt.sign(
      { id: 'usr_abc123', role: 'consumer' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    req.headers = { authorization: `Bearer ${consumerToken}` };
    requireConsumerAuth(req as any, res as any, next);
    expect(next).toHaveBeenCalled();
    expect((req as any).user).toEqual({
      id: 'usr_abc123',
      role: 'consumer',
    });
  });
});
