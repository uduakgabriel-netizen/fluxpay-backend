# FluxPay — Non-Custodial Solana Payment Gateway

> **"Accept any Solana token. Get paid in your favorite one."**

[![Solana](https://img.shields.io/badge/Solana-Devnet%20%7C%20Mainnet-14F195?logo=solana&logoColor=black)](https://solana.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Express](https://img.shields.io/badge/Express-4.19-000000?logo=express&logoColor=white)](https://expressjs.com)
[![Prisma](https://img.shields.io/badge/Prisma-5.14-2D3748?logo=prisma&logoColor=white)](https://prisma.io)
[![Jupiter](https://img.shields.io/badge/Jupiter-DEX%20Aggregator-orange)](https://jup.ag)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Hackathon](https://img.shields.io/badge/Colosseum-Hackathon%202026-purple)](https://colosseum.org)

---

## ⚡ Overview

**FluxPay** is an enterprise-grade, non-custodial payment gateway engineered on Solana. It enables merchants, developers, and creators to seamlessly accept payments in any SPL token or SOL, while settling instantly into their token of choice (e.g., USDC, SOL) or directly off-ramping into local bank accounts in fiat (NGN).

Built for both global online businesses and regional merchants in emerging markets, FluxPay abstracts the friction of multi-token liquidity, gas management, and fiat payouts through an intuitive developer API, hosted checkout sessions, and signed webhooks.

---

## ✨ Key Features

- 🔐 **Non-Custodial Architecture**: Merchants maintain 100% control over their funds. Zero central custody of customer capital.
- 🔄 **Any-Token to Any-Token Swaps**: Powered by the **Jupiter DEX Aggregator**, customers can pay with any SPL token (SOL, BONK, JUP, PYTH, WIF, etc.) while merchants receive their pre-configured settlement token.
- 🇳🇬 **Automated Fiat Settlement (NGN)**: Direct off-ramping to Nigerian bank accounts via integrated fiat rails.
- 🏦 **Monnify Bank Account Verification**: Real-time account number lookups and BVN/name verification before payout execution.
- 💧 **OneLiquidity Payout Rails**: Instant institutional-grade liquidity conversions from digital assets to local fiat rails.
- ⚡ **Real-Time Payment Detection**: Zero-latency webhook ingestion via **Helius** Solana webhooks with cryptographic HMAC signature validation.
- ⛽ **Automated Gas Sponsorship & SOL Buffer**: Intelligent network fee calculations and escrow management ensuring zero failed customer transactions.
- 🔁 **Enterprise Webhooks with Exponential Backoff**: Reliable payment delivery with cryptographic HMAC signatures (`X-FluxPay-Signature`) and BullMQ-backed retry queues.
- 🛡️ **Cryptographic Authentication**: Zero-trust ed25519 Solana wallet signature verification, single-use 5-minute nonces, and scoped merchant API keys (`sk_live_...`).

---

## 🏗️ Architecture Diagram

```text
 ┌──────────────┐
 │   Customer   │ (Pays with SOL, USDC, BONK, JUP, or any SPL token)
 └──────┬───────┘
        │ 1. Submits Payment Transaction
        ▼
 ┌──────────────┐         ExactOut Quote / Swap Route
 │ Jupiter DEX  │ ◄─────────────────────────────────────────────┐
 └──────┬───────┘                                               │
        │ 2. Converts to Merchant Settlement Token (e.g. USDC)   │
        ▼                                                       │
 ┌──────────────┐                                               │
 │ FluxPay API  │ ──────────────────────────────────────────────┘
 │  (Backend)   │
 └──────┬───────┘
        │ 3. Verifies On-Chain Confirmation via Helius
        ├───────────────────────────────────────────────────────┐
        ▼ (Crypto Settlement)                                   ▼ (Fiat Settlement)
 ┌──────────────┐                                        ┌──────────────┐
 │   Merchant   │                                        │ Escrow / NGN │
 │ Solana Wallet│                                        │  Providers   │
 └──────────────┘                                        └──────┬───────┘
                                                                │ 4. Verification & Payout
                                                                ▼
                                                        ┌──────────────┐
                                                        │ Monnify /    │
                                                        │ OneLiquidity │
                                                        └──────┬───────┘
                                                                │ 5. Bank Transfer
                                                                ▼
                                                        ┌──────────────┐
                                                        │ Merchant Bank│
                                                        │ Account (NGN)│
                                                        └──────────────┘
```

---

## 🛠️ Tech Stack

| Category | Technologies |
|---|---|
| **Blockchain** | Solana Web3.js, SPL Token, TweetNaCl, Helius RPC & Webhooks |
| **DEX Aggregation** | Jupiter v6 API (Ultra-low slippage, ExactOut swaps) |
| **Backend Core** | Node.js (v20+), TypeScript 5.4, Express 4.19, Zod validation |
| **Database & ORM** | PostgreSQL, Prisma ORM (with in-memory fallbacks for resilient dev) |
| **Fiat Settlement** | Monnify SDK / API, OneLiquidity institutional liquidity rails |
| **Queue & Cache** | Redis 7, BullMQ (Webhook delivery & event scheduling) |
| **Security** | AES-256-GCM encryption, ed25519 signatures, Helmet, Rate Limiting |
| **Notifications** | Resend (Transactional emails), Discord Webhooks (System alerts) |

---

## 🚀 Getting Started (Local Development)

### Prerequisites

Ensure you have installed:
- **Node.js**: v20.x or higher
- **pnpm** (recommended) or **npm**
- **PostgreSQL**: v14+ (optional for local dev; built-in memory mode supported)
- **Redis**: v6+ (optional for local dev; built-in memory queue supported)

### 1. Clone the Repository

```bash
git clone https://github.com/uduakgabriel-netizen/fluxpay-backend.git
cd fluxpay-backend
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Setup Environment Variables

Copy the provided environment template:

```bash
cp .env.example .env
```

Review `.env` and configure your keys (e.g., `DATABASE_URL`, `JWT_SECRET`, `SOLANA_NETWORK`).

### 4. Database Initialization

Generate Prisma client and apply database migrations:

```bash
npm run db:generate
npm run db:push
```

### 5. Start the Server

```bash
# Development mode with live reload
npm run dev

# Production build & start
npm run build
npm start
```

The API server will launch at `http://localhost:5000`. Verify status:
```bash
curl http://localhost:5000/api/health
```

---

## 🔐 Environment Variables

Reference [.env.example](file:///.env.example) for all variables and explanations:

- **Server & Database**: `PORT`, `NODE_ENV`, `DATABASE_URL`, `FRONTEND_URL`
- **Authentication**: `JWT_SECRET`, `JWT_EXPIRES_IN`, `ENCRYPTION_KEY`, `ADMIN_SECRET`
- **Solana Network & RPCs**: `SOLANA_NETWORK`, `SOLANA_RPC_PRIMARY`, `SOLANA_RPC_SECONDARY`, `SOLANA_RPC_FALLBACK`
- **Non-Custodial Fee Sponsor**: `FLUXPAY_WALLET_PUBLIC_KEY`, `FLUXPAY_WALLET_PRIVATE_KEY`
- **DEX & Data Feeds**: `JUPITER_API_URL`, `HELIUS_API_KEY`, `HELIUS_WEBHOOK_SECRET`
- **Fiat Settlement Rails**: `MONNIFY_API_KEY`, `MONNIFY_SECRET_KEY`, `ONELIQUIDITY_API_KEY`
- **Job Queues**: `REDIS_URL`

---

## 📡 Key API Endpoints

### 1. Hosted Checkout & Buyer Authentication
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/checkout/sessions` | Create a hosted checkout session (`Bearer API_KEY` or JWT) |
| `GET` | `/api/checkout/sessions/:id` | Fetch public session details and merchant preferences |
| `GET` | `/api/checkout/sessions/:id/status` | Lightweight status polling (`PENDING`, `COMPLETED`, etc.) |
| `POST` | `/api/checkout/sessions/:id/nonce` | Generate customer wallet ownership challenge nonce |
| `POST` | `/api/checkout/sessions/:id/verify` | Verify customer ed25519 wallet signature & issue buyer token |
| `POST` | `/api/checkout/sessions/:id/execute` | Execute swap & payment route (Requires verified buyer token) |
| `POST` | `/api/checkout/sessions/:id/confirm` | Confirm on-chain Solana transaction hash |

### 2. Merchant Authentication & Portal
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/nonce` | Request merchant authentication nonce |
| `POST` | `/api/auth/verify` | Verify merchant wallet signature & issue merchant JWT |
| `GET` | `/api/merchants/me` | Fetch authenticated merchant profile & balance |
| `PUT` | `/api/merchants/preferred-token` | Update preferred settlement token |

### 3. API Keys & Webhook Management
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/apikeys` | List active merchant API keys |
| `POST` | `/api/apikeys` | Create new secret API key (`sk_live_...`) with custom label |
| `DELETE` | `/api/apikeys/:id` | Revoke active API key |
| `GET` | `/api/merchants/secret` | Fetch or rotate webhook secret key |
| `POST` | `/api/merchants/webhook-url` | Update merchant destination webhook URL |
| `GET` | `/api/webhooks/logs` | Query webhook delivery logs and retry statuses |

### 4. Fiat Rails & Bank Verification
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/offramp/verify-account` | Verify bank account number and bank code via Monnify |
| `POST` | `/api/offramp/quote` | Fetch real-time crypto-to-fiat quote (USDC → NGN) |
| `POST` | `/api/offramp/payout` | Trigger automated bank disbursement |

---

## 🧪 Testing

FluxPay includes comprehensive test suites across unit calculations, auth middleware, cryptographic nonces, and checkout session lifecycles:

```bash
# Run all unit and integration tests
npm test

# Run auth flow verification test suite
npx ts-node scripts/test_auth_flows.ts
```

---

## 🚢 Deployment

FluxPay is configured for frictionless one-click deployment on **Render**, **Railway**, **Fly.io**, or **AWS ECS**.

For full step-by-step instructions, environment variable bundles, and troubleshooting guides, see [DEPLOYMENT.md](file:///DEPLOYMENT.md).

Quick summary for Render:
- **Environment**: Node
- **Root Directory**: `.`
- **Build Command**: `npm install && npm run build`
- **Start Command**: `npm start`
- **Health Check Path**: `/api/health`

---

## 📜 License

Licensed under the MIT License. Built with pride for the **Colosseum Solana Hackathon 2026**.

---

## 🤝 Contact & Community

- **Lead Developer**: [@uduakgabriel-netizen](https://github.com/uduakgabriel-netizen)
- **GitHub Repository**: [fluxpay-backend](https://github.com/uduakgabriel-netizen/fluxpay-backend)
- **Website**: [fluxpay.io](https://fluxpay.io)
