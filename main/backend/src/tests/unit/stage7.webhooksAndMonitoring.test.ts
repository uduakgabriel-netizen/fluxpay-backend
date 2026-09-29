import request from 'supertest';
import crypto from 'crypto';

jest.mock('nanoid', () => ({
  nanoid: () => 'mock_nanoid_123',
}));

import app from '../../app';
import { WebhookQueueService, RETRY_DELAYS } from '../../services/webhookQueue.service';
import { AlertService } from '../../services/alert.service';
import { memoryTransactions } from '../../services/offrampExecution.service';
import { memorySettlements } from '../../services/settlement.service';

describe('Stage 7: Webhooks, Retry Queue & Monitoring', () => {
  const heliusSecret = process.env.HELIUS_WEBHOOK_SECRET || '4f8b92d7e6c31a54f0a2e8c1b9d4e7f30291a8c7e6d5b4a3f2e1d0c9b8a7f6e5';
  const ngnSecret = process.env.NGN_WEBHOOK_SECRET || '8a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a2b';
  const usdeurSecret = process.env.USDEUR_WEBHOOK_SECRET || '1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d';

  function signPayload(payload: any, secret: string): string {
    const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return crypto.createHmac('sha256', secret).update(str).digest('hex');
  }

  describe('Webhook Endpoints — Signature Verification', () => {
    it('POST /api/webhooks/helius rejects invalid signature with 401', async () => {
      const payload = [{ signature: 'tx_sig_1', amount: 1000 }];
      const res = await request(app)
        .post('/api/webhooks/helius')
        .set('X-Helius-Signature', 'invalid_signature')
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Invalid webhook signature');
    });

    it('POST /api/webhooks/helius rejects missing signature with 401', async () => {
      const payload = [{ signature: 'tx_sig_1', amount: 1000 }];
      const res = await request(app)
        .post('/api/webhooks/helius')
        .send(payload);

      expect(res.status).toBe(401);
    });

    it('POST /api/webhooks/helius accepts valid HMAC signature and returns 200 { received: true }', async () => {
      const payload = [
        {
          signature: `sig_${Date.now()}`,
          reference: 'non_existent_ref',
          amount: 500,
        },
      ];
      const signature = signPayload(payload, heliusSecret);

      const res = await request(app)
        .post('/api/webhooks/helius')
        .set('X-Helius-Signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
    });

    it('POST /api/webhooks/ngn rejects invalid signature with 401', async () => {
      const payload = {
        event: 'payout.completed',
        providerRefId: 'mock_payout_123',
        status: 'completed',
      };

      const res = await request(app)
        .post('/api/webhooks/ngn')
        .set('X-NGN-Signature', 'bad_sig')
        .send(payload);

      expect(res.status).toBe(401);
    });

    it('POST /api/webhooks/ngn updates OffRampTransaction on payout.completed', async () => {
      const txId = `tx_test_${Date.now()}`;
      const providerRef = `payout_${Date.now()}`;

      // Insert transaction in memory
      memoryTransactions.set(txId, {
        id: txId,
        payoutRefId: providerRef,
        status: 'PAYOUT_PROCESSING',
        fiatAmount: '23019.00',
        fiatCurrency: 'NGN',
        merchantId: null,
      });

      const payload = {
        event: 'payout.completed',
        providerRefId: providerRef,
        status: 'completed',
        amount: '23019.00',
        currency: 'NGN',
        settledAt: new Date().toISOString(),
      };
      const signature = signPayload(payload, ngnSecret);

      const res = await request(app)
        .post('/api/webhooks/ngn')
        .set('X-NGN-Signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });

      const updated = memoryTransactions.get(txId);
      expect(updated.status).toBe('COMPLETED');
      expect(updated.completedAt).toBeDefined();
    });

    it('POST /api/webhooks/usdeur updates Settlement on payout.completed', async () => {
      const settleId = `settle_${Date.now()}`;
      const providerRef = `payout_usd_${Date.now()}`;

      memorySettlements.set(settleId, {
        id: settleId,
        providerRefId: providerRef,
        status: 'PROCESSING',
        fiatAmount: '100.00',
        fiatCurrency: 'USD',
        merchantId: 'merch_test_1',
      });

      const payload = {
        event: 'payout.completed',
        providerRefId: providerRef,
        status: 'completed',
        amount: '100.00',
        currency: 'USD',
        settledAt: new Date().toISOString(),
      };
      const signature = signPayload(payload, usdeurSecret);

      const res = await request(app)
        .post('/api/webhooks/usdeur')
        .set('X-USD-EUR-Signature', signature)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });

      const updated = memorySettlements.get(settleId);
      expect(updated.status).toBe('COMPLETED');
      expect(updated.settledAt).toBeDefined();
    });
  });

  describe('Webhook Retry Queue Service', () => {
    it('defines 6 retry delay steps', () => {
      expect(RETRY_DELAYS.length).toBe(6);
      expect(RETRY_DELAYS[0]).toBe(0); // immediate
      expect(RETRY_DELAYS[1]).toBe(60_000); // 1m
      expect(RETRY_DELAYS[2]).toBe(300_000); // 5m
      expect(RETRY_DELAYS[3]).toBe(900_000); // 15m
      expect(RETRY_DELAYS[4]).toBe(3_600_000); // 1h
      expect(RETRY_DELAYS[5]).toBe(21_600_000); // 6h
    });

    it('enqueue works with in-memory fallback', async () => {
      const result = await WebhookQueueService.enqueue({
        merchantId: 'm_test_1',
        event: 'payment.completed',
        data: { id: 'p_1' },
        url: 'https://example.com/webhook',
        secret: 'sec_123',
      });

      expect(result.queued).toBe(true);
      expect(result.logId).toBeDefined();
    });
  });

  describe('Monitoring Endpoints', () => {
    it('GET /api/health returns healthy system status', async () => {
      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.version).toBe('1.0.0');
      expect(res.body.uptime).toBeGreaterThanOrEqual(0);
      expect(res.body.services).toBeDefined();
      expect(res.body.services.providers).toEqual({
        jupiter: 'mock',
        ngn: 'mock',
        usdeur: 'mock',
      });
    });

    it('GET /api/admin/metrics requires admin authorization', async () => {
      const res = await request(app).get('/api/admin/metrics');
      expect(res.status).toBe(401);
    });

    it('GET /api/admin/metrics returns system metrics with admin bearer token', async () => {
      const res = await request(app)
        .get('/api/admin/metrics')
        .set('Authorization', 'Bearer admin-jwt');

      expect(res.status).toBe(200);
      expect(res.body.transactions).toBeDefined();
      expect(res.body.transactions.total).toBeDefined();
      expect(res.body.settlements).toBeDefined();
      expect(res.body.webhooks).toBeDefined();
      expect(res.body.wallet).toBeDefined();
      expect(res.body.wallet.balance).toBe('2.45 SOL');
      expect(res.body.wallet.status).toBe('healthy');
    });
  });

  afterAll(async () => {
    await WebhookQueueService.shutdown();
  });
});
