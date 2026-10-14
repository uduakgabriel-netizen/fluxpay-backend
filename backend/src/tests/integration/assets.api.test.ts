import request from 'supertest';
import express from 'express';
import assetsRoutes from '../../routes/assets.routes';

const testApp = express();
testApp.use(express.json());
testApp.use('/api/assets', assetsRoutes);

describe('Assets / Sellable Tokens API (Integration Tests)', () => {
  it('GET /api/assets/sellable returns list of tokens and total', async () => {
    const res = await request(testApp).get('/api/assets/sellable');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('tokens');
    expect(res.body).toHaveProperty('total');
    expect(Array.isArray(res.body.tokens)).toBe(true);
    expect(res.body.tokens.length).toBeGreaterThanOrEqual(1);

    const first = res.body.tokens[0];
    expect(first).toHaveProperty('mint');
    expect(first).toHaveProperty('symbol');
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('decimals');
    expect(first).toHaveProperty('logoURI');
  });

  it('GET /api/assets/sellable?search=bonk filters by symbol/name', async () => {
    const res = await request(testApp).get('/api/assets/sellable?search=bonk');

    expect(res.status).toBe(200);
    expect(res.body.tokens.length).toBeGreaterThanOrEqual(1);
    for (const t of res.body.tokens) {
      const match =
        t.symbol.toLowerCase().includes('bonk') ||
        t.name.toLowerCase().includes('bonk');
      expect(match).toBe(true);
    }
  });

  it('GET /api/assets/sellable/:mint returns single token', async () => {
    const bonkMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const res = await request(testApp).get(`/api/assets/sellable/${bonkMint}`);

    expect(res.status).toBe(200);
    expect(res.body.mint).toBe(bonkMint);
    expect(res.body.symbol).toBe('BONK');
    expect(res.body.name).toBe('Bonk');
    expect(res.body.decimals).toBe(5);
    expect(res.body).toHaveProperty('logoURI');
  });

  it('GET /api/assets/sellable/:mint returns 404 for unknown mint', async () => {
    const res = await request(testApp).get('/api/assets/sellable/UnknownMint1111111111111111111111111111111');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Token not found' });
  });
});
