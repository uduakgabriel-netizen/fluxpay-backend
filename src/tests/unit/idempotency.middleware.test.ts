import { Request, Response } from 'express';
import { idempotencyMiddleware } from '../../middleware/idempotency';
import { cacheService } from '../../services/cache.service';

jest.mock('../../services/cache.service', () => ({
  cacheService: {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(true),
  },
}));

describe('Idempotency Middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock;

  beforeEach(() => {
    req = {
      method: 'POST',
      path: '/api/payments',
      headers: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      statusCode: 200,
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  it('throws 400 if Idempotency-Key header is missing', async () => {
    await idempotencyMiddleware(req as Request, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Idempotency-Key header is required for this endpoint' });
  });

  it('returns cached response if key exists', async () => {
    req.headers!['idempotency-key'] = '12345';
    (cacheService.get as jest.Mock).mockResolvedValue({ statusCode: 201, body: { success: true } });

    await idempotencyMiddleware(req as Request, res as Response, next);
    
    expect(cacheService.get).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next and caches on successful new request', async () => {
    req.headers!['idempotency-key'] = '12345';
    (cacheService.get as jest.Mock).mockResolvedValue(null);

    await idempotencyMiddleware(req as Request, res as Response, next);
    
    expect(next).toHaveBeenCalled();

    // simulate res.json being called inside the route controller
    const originalJson = (res as any).json;
    originalJson({ id: 1 });
    
    expect(cacheService.set).toHaveBeenCalled();
  });
});
