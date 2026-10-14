# FluxPay Backend — Production Deployment Guide

This guide walks you through deploying the **FluxPay Backend** to **Render** (or any modern cloud container platform) with high availability, database connectivity, and zero-downtime health checks.

---

## 🚀 1. Quick Deploy to Render

### Step 1: Create a New Web Service
1. Log in to your [Render Dashboard](https://dashboard.render.com).
2. Click **New +** → **Web Service**.
3. Connect your GitHub repository:
   ```text
   https://github.com/uduakgabriel-netizen/fluxpay-backend
   ```

### Step 2: Configure Service Settings
Fill in the deployment settings:

| Setting | Value |
|---|---|
| **Name** | `fluxpay-backend` |
| **Region** | Oregon (US West) or Frankfurt (EU Central) |
| **Branch** | `main` |
| **Root Directory** | `.` *(Must be dot / root — do not leave empty)* |
| **Runtime** | `Node` |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `npm start` |
| **Instance Type** | Starter ($7/mo) or Standard (Recommended) |

### Step 3: Configure Health Check Path
Under **Advanced** → **Health Check Path**:
```text
/api/health
```
Render will use this endpoint to ensure zero-downtime deploys.

---

## 🗄️ 2. PostgreSQL Database Setup

1. On Render, click **New +** → **PostgreSQL**.
2. Set Database Name: `fluxpay`.
3. Copy the **Internal Database URL** (e.g. `postgresql://fluxpay_user:...@dpg-...-a/fluxpay`).
4. Set this URL as `DATABASE_URL` in your Web Service environment variables.
5. In your local or CI environment, run migrations once:
   ```bash
   npx prisma db push
   ```

---

## 📋 3. Complete Environment Variables to Paste

In your Render Web Service settings, navigate to the **Environment** tab and paste the following environment variables:

```bash
# Server Configuration
PORT=5000
NODE_ENV=production
FRONTEND_URL=https://fluxpay.io
LOG_LEVEL=info

# Database (From Render PostgreSQL)
DATABASE_URL=postgresql://user:password@host/fluxpay?sslmode=require

# Authentication & Encryption
JWT_SECRET=super-secure-production-jwt-secret-min-64-chars
JWT_EXPIRES_IN=7d
ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
ADMIN_SECRET=prod-admin-secret-fluxpay-2026
ADMIN_EMAIL=admin@fluxpay.io

# Solana Network Configuration
SOLANA_NETWORK=mainnet-beta
SOLANA_RPC_PRIMARY=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
SOLANA_RPC_SECONDARY=https://api.mainnet-beta.solana.com
SOLANA_RPC_FALLBACK=https://solana-api.projectserum.com

# Non-Custodial Gas Sponsor / Escrow Wallets
FLUXPAY_WALLET_PUBLIC_KEY=YOUR_SOLANA_GAS_WALLET_PUBLIC_KEY
FLUXPAY_WALLET_PRIVATE_KEY=YOUR_SOLANA_GAS_WALLET_PRIVATE_KEY
FLUXPAY_ESCROW_WALLET_PUBLIC_KEY=YOUR_SOLANA_ESCROW_WALLET_PUBLIC_KEY
FLUXPAY_ESCROW_WALLET_PRIVATE_KEY_BASE64=YOUR_SOLANA_ESCROW_WALLET_PRIVATE_KEY_BASE64

# DEX & Real-Time Monitoring
JUPITER_API_URL=https://quote-api.jup.ag/v6
HELIUS_API_KEY=YOUR_HELIUS_API_KEY
HELIUS_WEBHOOK_SECRET=YOUR_HELIUS_WEBHOOK_SECRET

# Fiat Settlement Rails (Monnify & OneLiquidity)
USE_MOCK_PROVIDERS=false
MONNIFY_API_KEY=MK_PROD_YOUR_KEY
MONNIFY_SECRET_KEY=YOUR_MONNIFY_SECRET
MONNIFY_BASE_URL=https://api.monnify.com
MONNIFY_CONTRACT_CODE=YOUR_CONTRACT_CODE
ONELIQUIDITY_API_KEY=YOUR_ONELIQUIDITY_API_KEY
ONELIQUIDITY_BASE_URL=https://api.oneliquidity.technology
ONELIQUIDITY_WEBHOOK_SECRET=YOUR_ONELIQUIDITY_WEBHOOK_SECRET
NGN_WEBHOOK_SECRET=YOUR_NGN_WEBHOOK_SECRET

# Webhooks & Queue
REDIS_URL=redis://default:password@host:6379
WEBHOOK_TIMEOUT_MS=10000
FLUXPAY_WEBHOOK_SECRET=whsec_your_production_secret

# Notifications & Alerts
RESEND_API_KEY=re_your_resend_api_key
RESEND_FROM_EMAIL=notifications@fluxpay.io
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
ALERT_SWAP_FAILURE_THRESHOLD=5
ALERT_WALLET_BALANCE_THRESHOLD=0.1
```

---

## 🔍 4. Verification & Health Check

Once deployed, verify that the backend is responding correctly:

### 1. Public Health Check
```bash
curl -i https://your-fluxpay-backend.onrender.com/api/health
```
**Expected Response (HTTP 200)**:
```json
{
  "status": "ok",
  "timestamp": "2026-10-12T22:00:00.000Z",
  "services": {
    "database": "connected",
    "redis": "connected",
    "providers": {
      "jupiter": "real",
      "ngn": "real",
      "usdeur": "real"
    }
  },
  "version": "1.0.0",
  "uptime": 120
}
```

### 2. Verify Auth Guard
```bash
curl -i https://your-fluxpay-backend.onrender.com/api/merchants/me
```
**Expected Response (HTTP 401)**:
```json
{
  "error": "No token provided"
}
```

---

## 🛠️ 5. Common Deployment Issues & Fixes

### Issue 1: `PrismaClientInitializationError: Authentication failed against database server`
- **Cause**: Incorrect database connection string or missing `?sslmode=require`.
- **Fix**: Ensure Render PostgreSQL's internal URL is used and includes SSL parameters:
  ```text
  DATABASE_URL="postgresql://user:password@dpg-...-a/fluxpay?sslmode=require"
  ```
- *Note*: FluxPay backend includes safe in-memory fallbacks so services will never crash if the database experiences temporary downtime.

### Issue 2: `Cannot find module './dist/index.js'`
- **Cause**: TypeScript compilation step skipped during build.
- **Fix**: Make sure Build Command is:
  ```bash
  npm install && npm run build
  ```
  And Start Command is:
  ```bash
  npm start
  ```

### Issue 3: `Root Directory Not Found / ENOENT`
- **Cause**: Render was set to a nested folder (e.g. `backend`).
- **Fix**: Set **Root Directory** to `.` in Render Dashboard → Settings.

### Issue 4: `Webhook delivery timeout`
- **Cause**: Merchant endpoint slow to respond or blocked by firewall.
- **Fix**: FluxPay defaults to a 10,000ms timeout with exponential backoff retries managed by BullMQ. Check Redis connectivity if retries are lagging.

---

## 🔒 Security Checklist Before Going Live

- [ ] All `.env` secrets are kept strictly within Render Environment settings.
- [ ] Gas wallet holds only operational SOL (do not store excessive treasury funds).
- [ ] Database credentials utilize private network hostnames.
- [ ] `NODE_ENV` is set to `production`.
- [ ] Discord webhook is configured for instant critical failure alerts.
