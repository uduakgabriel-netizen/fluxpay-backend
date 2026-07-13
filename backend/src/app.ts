import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth.routes';
import paymentRoutes from './routes/payment.routes';
import refundRoutes from './routes/refund.routes';
import settlementRoutes from './routes/settlement.routes';
import apikeyRoutes from './routes/apikey.routes';
import webhookRoutes from './routes/webhook.routes';
import heliusRoutes from './routes/helius.routes';
import blockchainRoutes from './routes/blockchain.routes';
import invoiceRoutes from './routes/invoice.routes';
import subscriptionRoutes from './routes/subscription.routes';
import teamRoutes from './routes/team.routes';
import tokenRoutes from './routes/token.routes';
import merchantRoutes from './routes/merchant.routes';
import checkoutRoutes from './routes/checkout.routes';
import { errorHandler } from './middleware/errorHandler';
import { requestIdMiddleware } from './middleware/requestId';

const app = express();

// ─── Security Headers ──────────────────────────────────────
app.use(helmet());

// ─── Request Tracing ───────────────────────────────────────
app.use(requestIdMiddleware);

// ─── CORS ───────────────────────────────────────────────────
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, server-to-server)
      if (!origin) return callback(null, true);
      // Allow frontend, checkout, and any merchant site
      const allowedOrigins = [
        process.env.FRONTEND_URL || 'http://localhost:3000',
        process.env.FLUXPAY_CHECKOUT_URL || 'http://localhost:3000',
      ];
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // Allow any origin for checkout API (merchants call from their sites)
      return callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Helius-Api-Key', 'X-Idempotency-Key'],
  })
);

// ─── Body Parsing ───────────────────────────────────────────
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Rate Limiting ──────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // 30 requests per minute per IP
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to auth routes
app.use('/api/auth', limiter);

// ─── Health Check ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'fluxpay-backend',
  });
});

// ─── Routes ─────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/refunds', refundRoutes);
app.use('/api/settlements', settlementRoutes);
app.use('/api/api-keys', apikeyRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/webhooks/helius', heliusRoutes);
app.use('/api/blockchain', blockchainRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/team', teamRoutes);
app.use('/api/tokens', tokenRoutes);
app.use('/api/merchants', merchantRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/checkout', checkoutRoutes); // Added to support /checkout/sessions directly

// ─── 404 Handler ────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ─── Global Error Handler ───────────────────────────────────
app.use(errorHandler);

export default app;
