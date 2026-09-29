PROMPT FOR ENGINEER: STAGE 7 + STAGE 8 — WEBHOOKS, MONITORING & FRONTEND WIRING
Objective
Complete the backend with two final stages:

Stage 7 — Webhooks & Monitoring (real-time status updates, retry queues, admin alerts)

Stage 8 — Frontend Wiring (connect every frontend screen to real backend endpoints)

Stage 7 continues using mock providers. Stage 8 is the moment the frontend stops using mock data and starts consuming the real backend.

PART 1: STAGE 7 — WEBHOOKS & MONITORING
1.1 Webhook Receiver Endpoints
Create these under /api/webhooks/.

Endpoint 1: POST /api/webhooks/helius
Purpose: Receive payment detection from Helius.

Auth: HMAC signature verification (no JWT)

Request: Helius webhook payload (array of transactions)

Logic:

Verify HMAC signature using HELIUS_WEBHOOK_SECRET

If invalid → AuthError (401), log attempt, do NOT process

For each transaction:

Extract payment reference (order ID)

Find the matching payment in DB

If not found → log warning, continue

Update payment status to DETECTED

Trigger settlement logic (crypto or fiat branch)

Return 200 { received: true } — always, even on partial failures

Log every attempt in WebhookLog table

Error handling:

Invalid signature → 401, no processing

Payment not found → log, continue

DB error → log, return 200 (Helius will retry)

Duplicate transaction → idempotency check by txHash

Endpoint 2: POST /api/webhooks/ngn
Purpose: Receive payout status updates from NGN provider.

Auth: HMAC signature verification

Request payload (mock):

json
{
  "event": "payout.completed",
  "providerRefId": "mock_payout_xyz",
  "status": "completed",
  "amount": "23019.00",
  "currency": "NGN",
  "settledAt": "2026-09-28T04:05:00Z"
}
Logic:

Verify signature

Find matching OffRampTransaction or Settlement by providerRefId

Update status based on event:

payout.processing → PAYOUT_PROCESSING

payout.completed → COMPLETED, set completedAt

payout.failed → FAILED, store error

Use assertTransition — reject invalid transitions

Return 200 { received: true }

Endpoint 3: POST /api/webhooks/usdeur
Purpose: Same as above but for USD/EUR provider.

1.2 Webhook Retry Queue (BullMQ)
Create src/services/webhookQueue.service.ts.

When a webhook fails to deliver (outgoing to merchant):

Attempt	Delay
1	Immediate
2	1 minute
3	5 minutes
4	15 minutes
5	1 hour
6	6 hours
After 6 failures → mark as FAILED, alert admin.

Rules:

Use existing Redis connection

If Redis is down → fall back to in-memory queue (log warning)

Store every attempt in WebhookLog

1.3 Alerting
Discord alerts (admin only):

Event	Severity	Message
Webhook signature invalid	Warning	"Invalid webhook signature from [provider]"
5+ webhook failures in 10 min	Warning	"High webhook failure rate"
Settlement failed 3 times	Critical	"Settlement [id] permanently failed"
Transaction stuck > 30 min	Critical	"Transaction [id] stuck in [status]"
Wallet balance < 0.1 SOL	Critical	"Low gas wallet balance: [balance] SOL"
Provider API error rate > 10%	Warning	"Provider [name] error rate elevated"
Email alerts (Resend):

Event	Recipient
Settlement completed	Merchant
Payout failed	Merchant + Admin
Transaction refunded	Consumer + Admin
1.4 Monitoring Endpoints
GET /api/health
Public endpoint — returns system health.

Response:

json
{
  "status": "ok",
  "timestamp": "2026-09-28T04:00:00Z",
  "services": {
    "database": "connected",
    "redis": "connected",
    "providers": {
      "jupiter": "mock",
      "ngn": "mock",
      "usdeur": "mock"
    }
  },
  "version": "1.0.0",
  "uptime": 3600
}
GET /api/admin/metrics
Auth: Admin only

Response:

json
{
  "transactions": {
    "total": 1247,
    "completed": 1200,
    "failed": 47,
    "pending": 0,
    "successRate": "96.2%"
  },
  "settlements": {
    "total": 89,
    "completed": 85,
    "failed": 4,
    "pending": 0
  },
  "webhooks": {
    "last24h": 342,
    "successful": 340,
    "failed": 2,
    "successRate": "99.4%"
  },
  "wallet": {
    "balance": "2.45 SOL",
    "status": "healthy"
  }
}
PART 2: STAGE 8 — FRONTEND WIRING
2.1 Environment Setup
Frontend .env.local:

text
NEXT_PUBLIC_API_URL=http://localhost:5000
Vercel production env:

text
NEXT_PUBLIC_API_URL=https://fluxpay-backend-0ez8.onrender.com
Verify CORS on backend allows both origins.

2.2 API Client Setup
Create src/services/api/client.ts in the frontend.

Requirements:

Axios instance with baseURL = process.env.NEXT_PUBLIC_API_URL

Request interceptor — attach JWT from localStorage if present

Response interceptor — handle 401 (redirect to login), 403, 500

Error normalization — convert backend error shape to a consistent frontend error

Retry on network errors (max 2)

Backend error shape:

json
{ "error": "...", "code": "...", "details": {...} }
Frontend should surface error message to the user, and code for logic.

2.3 API Service Files
Create these in src/services/api/:

File	Endpoints	Purpose
authApi.ts	/api/auth/consumer/nonce, /verify, /me	Consumer auth
assetsApi.ts	/api/assets/sellable	Token list
quoteApi.ts	/api/offramp/quote	Quote generation
payoutApi.ts	/api/payout-accounts/*	Payout account CRUD
offrampApi.ts	/api/offramp/*	Transaction execution
merchantSettingsApi.ts	/api/merchant/settings/*	Merchant settlement settings
merchantSettlementsApi.ts	/api/merchant/settlements/*	Merchant settlements
transactionsApi.ts	/api/offramp/transactions	Consumer transaction history
2.4 Replace Mock Data in Consumer Flow
Screen	Current Mock Source	New API Call
/sell (Connect Wallet)	ConsumerContext mock	authApi.requestNonce() + authApi.verify()
/sell/home	ConsumerContext mock portfolio	New endpoint: GET /api/consumer/portfolio (or compute from token registry + wallet)
/sell/sell (Token Select)	mock-data.ts tokens	assetsApi.getSellableTokens()
/sell/sell (Amount)	Local state	Local (no API)
/sell/quote	Mock quote	quoteApi.generateQuote()
/sell/payout	Mock accounts	payoutApi.listAccounts() + payoutApi.verifyAccount()
/sell/confirm	Local state	Local (no API)
/sell/processing	Local state	Poll offrampApi.getStatus() every 2s
/sell/success	Local state	From offrampApi.submit() response
/sell/transactions	Mock history	transactionsApi.list()
/sell/transaction/:id	Mock detail	transactionsApi.getById()
/sell/wallets	Mock wallet	From consumer JWT + wallet adapter
/sell/settings	Mock settings	New endpoint: GET /api/consumer/settings (or local)
2.5 Replace Mock Data in Merchant Flow
Screen	Current Mock Source	New API Call
/dashboard	Mock stats	Existing merchant endpoints (verify they exist)
/dashboard/swap	MerchantSettlementContext	quoteApi.generateQuote() + offrampApi.execute()
/dashboard/settlements	MerchantSettlementContext	merchantSettlementsApi.list()
/dashboard/settlements/:id	MerchantSettlementContext	merchantSettlementsApi.getById()
/dashboard/settings/settlement	MerchantSettlementContext	merchantSettingsApi.get() + patch()
/dashboard/settings/payout-accounts	MerchantSettlementContext	payoutApi.listAccounts()
2.6 Auth Integration
On app load:

Check localStorage for fluxpay_consumer_token or fluxpay_merchant_token

If present → call /api/auth/consumer/me or /api/auth/merchant/me to validate

If valid → hydrate user state

If invalid → clear token, redirect to login

On wallet connect:

Get nonce → sign → verify → store JWT

Redirect to /sell/home

On logout:

Clear token from localStorage

Disconnect wallet

Redirect to landing page

2.7 Real-Time Status Polling
During transaction processing (/sell/processing and /dashboard/swap/processing):

Poll GET /api/offramp/transactions/:id/status every 2 seconds

Update UI step indicator based on step field

Stop polling when isTerminal: true

If transaction fails → show error state with retry

Add a fallback timeout: stop polling after 5 minutes → show "Transaction is taking longer than expected"

2.8 Error Handling in Frontend
For every API call:

Wrap in try/catch

Display backend's error message (never raw stack traces)

Show retry button for transient errors (5xx, network)

Do NOT retry for 4xx errors

Toast on error + inline error card where appropriate

Log errors to console with code for debugging

Mapping:

HTTP Status	Code	UI Action
400	VALIDATION_ERROR	Inline field error
401	AUTH_ERROR	Redirect to login
403	FORBIDDEN	Toast "Access denied"
404	NOT_FOUND	Show empty state
409	CONFLICT	Toast + refresh
410	QUOTE_EXPIRED	Toast + auto-refresh quote
422	INSUFFICIENT_FUNDS	Inline error + link to add funds
502	PROVIDER_ERROR	Retry button
500	INTERNAL_ERROR	Toast "Something went wrong"
2.9 Remove Mock Data Files
Once wiring is complete:

Delete src/lib/mock-data.ts (consumer)

Remove mock data from ConsumerContext.tsx

Remove mock data from MerchantSettlementContext.tsx

Keep these contexts for state management — just feed them real data

PART 3: FOLDER STRUCTURE
Backend additions:

text
src/
├── routes/
│   └── webhooks.routes.ts
├── controllers/
│   └── webhooks.controller.ts
├── services/
│   └── webhookQueue.service.ts
├── middleware/
│   └── verifyWebhookSignature.ts
└── jobs/
    └── webhookRetry.job.ts (if not using BullMQ)
Frontend additions:

text
src/services/api/
├── client.ts
├── authApi.ts
├── assetsApi.ts
├── quoteApi.ts
├── payoutApi.ts
├── offrampApi.ts
├── merchantSettingsApi.ts
├── merchantSettlementsApi.ts
└── transactionsApi.ts
PART 4: ENVIRONMENT VARIABLES
Backend:

text
HELIUS_WEBHOOK_SECRET=<generate random 32-byte hex>
NGN_WEBHOOK_SECRET=<generate random 32-byte hex>
USDEUR_WEBHOOK_SECRET=<generate random 32-byte hex>
Frontend (local .env.local):

text
NEXT_PUBLIC_API_URL=http://localhost:5000
Frontend (Vercel):

text
NEXT_PUBLIC_API_URL=https://fluxpay-backend-0ez8.onrender.com
PART 5: ACCEPTANCE CRITERIA
Stage 7
□ 3 webhook receiver endpoints (Helius, NGN, USD/EUR)
□ HMAC signature verification on all webhooks
□ Invalid signature → 401, no processing
□ Webhook events logged in WebhookLog
□ Retry queue with 6 attempts
□ Retry falls back to in-memory if Redis down
□ Discord alerts for critical events
□ Email alerts for merchant/consumer events
□ GET /api/health returns service status
□ GET /api/admin/metrics returns system metrics
□ Idempotency: duplicate webhooks don't double-process
Stage 8
□ API client with interceptors
□ 8 API service files created
□ Consumer flow wired to real APIs (all screens)
□ Merchant flow wired to real APIs (all screens)
□ Auth flow works end-to-end
□ Status polling works during processing
□ Error handling maps backend errors to UI correctly
□ Mock data files removed
□ End-to-end test: BONK → NGN → bank (mock providers)
□ End-to-end test: merchant fiat settlement (mock)
□ Build passes with 0 errors
Both Stages
□ No regressions in existing flows
□ All tests pass
□ No stack traces leaked to frontend
□ No real provider APIs called
PART 6: TESTING INSTRUCTIONS
Test Stage 7
1. Webhook signature validation:

bash
# Valid signature
curl -X POST /api/webhooks/helius -H "X-Helius-Signature: <valid>" ...

# Invalid signature (should 401)
curl -X POST /api/webhooks/helius -H "X-Helius-Signature: invalid" ...
2. Health check:

bash
curl https://fluxpay-backend-0ez8.onrender.com/api/health
3. Admin metrics:

bash
curl https://fluxpay-backend-0ez8.onrender.com/api/admin/metrics \
  -H "Authorization: Bearer <ADMIN_JWT>"
Test Stage 8
1. Consumer flow:

Open /sell

Connect Phantom wallet

Sign message

Verify dashboard loads with real token list

Select BONK, enter 10,000

Verify quote shows real rate

Select OPay account

Confirm → watch status polling

Verify success screen shows real transaction ID

2. Merchant flow:

Log in as merchant

Go to /dashboard/settings/settlement

Set preference to FIAT + NGN

Select payout account

Save

Go to /dashboard/settlements

Verify settlement list loads from backend

PART 7: WHAT NOT TO DO
❌ Do not process webhooks without signature verification

❌ Do not double-process duplicate webhooks

❌ Do not leak stack traces to frontend

❌ Do not remove context providers (keep state management)

❌ Do not hardcode API URLs in frontend (use env variable)

❌ Do not skip error mapping

❌ Do not block the whole flow if one webhook fails

❌ Do not use real provider APIs

PART 8: FINAL INSTRUCTION
Engineer: Build Stage 7 + Stage 8 together. This completes the backend and wires the frontend.

Stage 7: Webhook receivers with signature verification, retry queue, alerts, health check, admin metrics.

Stage 8: API client, 8 service files, replace all mock data in both flows, wire auth, status polling, error mapping.

Report back when:

All 3 webhook endpoints verify signatures correctly

Retry queue works (test with forced failures)

GET /api/health returns healthy status

Consumer flow works end-to-end with real APIs

Merchant flow works end-to-end with real APIs

Mock data files removed

Build passes with 0 errors

End-to-end test: BONK → NGN → bank (using mock providers)

No regressions in existing testss