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
const corsOptionsDelegate = (req: express.Request, callback: (err: Error | null, options?: cors.CorsOptions) => void) => {
  const origin = req.header('Origin');
  
  // Helper function to extract the origin (scheme + domain + port) from a URL string
  const getOrigin = (urlStr: string): string => {
    try {
      return new URL(urlStr).origin;
    } catch {
      return urlStr.replace(/\/$/, ''); // Fallback: remove trailing slash
    }
  };

  const allowedOrigins: (string | RegExp)[] = [
    'http://localhost:3000',
    'https://fluxpay-frontend.vercel.app',
    'https://fluxpay-frontend-ec3o.vercel.app',
    'https://fluxpay-frontend-ec3o-nuy139igk.vercel.app',
    'https://fluxpay-frontend-e-git-56a9e8-preciousnelson1255-5735s-projects.vercel.app',
    /\.vercel\.app$/
  ];

  // Add environment-configured frontend and checkout URLs
  if (process.env.FRONTEND_URL) {
    allowedOrigins.push(getOrigin(process.env.FRONTEND_URL));
  }
  if (process.env.FLUXPAY_CHECKOUT_URL) {
    allowedOrigins.push(getOrigin(process.env.FLUXPAY_CHECKOUT_URL));
  }

  let isAllowed = false;

  if (!origin) {
    isAllowed = true;
  } else {
    // 1. Check if it is in the hardcoded or environment-configured allowed list
    const isInAllowedList = allowedOrigins.some(pattern => {
      if (typeof pattern === 'string') return origin === pattern;
      if (pattern instanceof RegExp) return pattern.test(origin);
      return false;
    });
    
    if (isInAllowedList) {
      isAllowed = true;
    }

    // 2. Always allow checkout and payment API requests from any merchant's website
    if (!isAllowed) {
      const isPublicPath =
        req.path.startsWith('/checkout') ||
        req.path.startsWith('/api/checkout') ||
        req.path.startsWith('/api/payments');
      if (isPublicPath) {
        isAllowed = true;
      }
    }
  }

  if (isAllowed) {
    callback(null, {
      origin: origin ? origin : true,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Helius-Api-Key', 'X-Idempotency-Key', 'X-Request-Id'],
    });
  } else {
    console.warn(`CORS blocked origin: ${origin} for path: ${req.path}`);
    callback(new Error('Not allowed by CORS'));
  }
};

app.use(cors(corsOptionsDelegate));

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
