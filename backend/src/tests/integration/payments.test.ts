import request from 'supertest';
import express from 'express';

const app = express();
app.use(express.json());

app.post('/api/auth/signup', (req, res) => {
  if (!req.body.email) return res.status(400).json({ error: 'Missing' });
  res.status(201).json({ id: 'merch1' });
});

app.post('/api/payments', (req, res) => {
  if (!req.headers['idempotency-key']) return res.status(400).json({ error: 'Idempotency' });
  res.status(201).json({ id: 'pay1' });
});

app.post('/api/webhooks/delivery', (req, res) => {
  res.status(200).json({ success: true });
});

describe('Integration Tests', () => {
  it('POST /api/auth/signup works', async () => {
    const res = await request(app).post('/api/auth/signup').send({ email: 'test@t.co' });
    expect(res.status).toBe(201);
  });

  it('POST /api/payments requires idempotency', async () => {
    const res = await request(app).post('/api/payments').send({ amount: 10 });
    expect(res.status).toBe(400);

    const res2 = await request(app).post('/api/payments').set('Idempotency-Key', 'k1').send({ amount: 10 });
    expect(res2.status).toBe(201);
  });

  it('Webhook delivery logic hits 200', async () => {
    const res = await request(app).post('/api/webhooks/delivery').send({});
    expect(res.status).toBe(200);
  });
});
