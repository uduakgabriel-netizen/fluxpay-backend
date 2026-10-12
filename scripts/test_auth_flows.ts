import dotenv from 'dotenv';
dotenv.config();

import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import jwt from 'jsonwebtoken';

const API_BASE = 'http://localhost:5000/api';

async function runTests() {
  console.log('=== STARTING FLUXPAY AUTHENTICATION FLOW VERIFICATION ===\n');
  let passed = 0;
  let failed = 0;

  function assert(condition: any, message: string) {
    if (Boolean(condition)) {
      console.log(`✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${message}`);
      failed++;
    }
  }

  // --- TEST 1: Merchant Route Rejects Unauthenticated Requests ---
  {
    const res = await fetch(`${API_BASE}/merchants/me`);
    const data: any = await res.json();
    assert(res.status === 401 && data.error === 'No token provided', 
      `Merchant route rejects unauthenticated requests (HTTP ${res.status}, error: "${data.error}")`);
  }

  // --- TEST 2: Merchant Route Rejects Invalid JWT ---
  {
    const res = await fetch(`${API_BASE}/merchants/me`, {
      headers: { Authorization: 'Bearer this.is.an.invalid.token' }
    });
    const data: any = await res.json();
    assert(res.status === 401, `Merchant route rejects invalid JWT (HTTP ${res.status})`);
  }

  // --- TEST 3: Merchant Route Rejects Non-Merchant JWT (e.g. consumer) ---
  {
    const fakeConsumerToken = jwt.sign(
      { id: 'cons_123', walletAddress: 'SomeWallet123', role: 'consumer' },
      process.env.JWT_SECRET || 'dev-secret-key-change-in-prod-fluxpay-2024'
    );
    const res = await fetch(`${API_BASE}/merchants/me`, {
      headers: { Authorization: `Bearer ${fakeConsumerToken}` }
    });
    const data: any = await res.json();
    assert(res.status === 401 && data.error?.includes('Merchant role required'),
      `Merchant route rejects non-merchant role JWT (HTTP ${res.status}, error: "${data.error}")`);
  }

  // --- TEST 4: Merchant Login Flow (Nonce -> ed25519 Signature -> JWT role: merchant) ---
  const merchantKeypair = Keypair.generate();
  const merchantWallet = merchantKeypair.publicKey.toBase58();
  let merchantJwt = '';

  {
    // Step 1: Request Nonce
    const nonceRes = await fetch(`${API_BASE}/auth/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: merchantWallet }),
    });
    const nonceData: any = await nonceRes.json();
    assert(nonceRes.status === 200 && nonceData.nonce, 
      `Merchant can request auth nonce (received: "${nonceData.nonce?.slice(0, 10)}...")`);

    // Step 2: Test Invalid Signature Rejection
    const invalidVerifyRes = await fetch(`${API_BASE}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: merchantWallet,
        message: `Sign this message to verify your wallet: ${nonceData.nonce}`,
        signature: 'invalid_signature_base64',
      }),
    });
    assert(invalidVerifyRes.status === 401, 
      `Backend rejects invalid merchant signature (HTTP ${invalidVerifyRes.status})`);

    // Step 3: Sign message with real Solana ed25519 private key
    const nonceRes2 = await fetch(`${API_BASE}/auth/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: merchantWallet }),
    });
    const { nonce: freshNonce }: any = await nonceRes2.json();
    const message = `Sign this message to verify your wallet: ${freshNonce}`;
    const messageBytes = new TextEncoder().encode(message);
    const sigBytes = nacl.sign.detached(messageBytes, merchantKeypair.secretKey);
    const signatureBase64 = Buffer.from(sigBytes).toString('base64');

    const verifyRes = await fetch(`${API_BASE}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: merchantWallet,
        message,
        signature: signatureBase64,
      }),
    });
    const verifyData: any = await verifyRes.json();
    merchantJwt = verifyData.sessionToken;

    assert(verifyRes.status === 200 && merchantJwt, 
      `Merchant signature verified and sessionToken issued`);

    // Decode token to verify role: "merchant"
    const decoded: any = jwt.decode(merchantJwt);
    assert(decoded && decoded.role === 'merchant',
      `Merchant JWT contains role: "merchant" (role: "${decoded?.role}")`);

    // Step 4: Verify single-use nonce (replay attack prevented)
    const replayRes = await fetch(`${API_BASE}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: merchantWallet,
        message,
        signature: signatureBase64,
      }),
    });
    assert(replayRes.status === 400,
      `Replay attack prevented: used nonce is deleted immediately (HTTP ${replayRes.status})`);

    // Step 5: Access protected route with valid merchant JWT
    const meRes = await fetch(`${API_BASE}/merchants/me`, {
      headers: { Authorization: `Bearer ${merchantJwt}` }
    });
    const meData: any = await meRes.json();
    assert(meRes.status === 200 && meData.walletAddress === merchantWallet,
      `Protected /dashboard merchant API accepts valid signed JWT (HTTP ${meRes.status})`);
  }

  // --- TEST 5: Checkout Authentication Flow ---
  {
    // Step 1: Create a checkout session
    const createSessionRes = await fetch(`${API_BASE}/checkout/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${merchantJwt}`,
      },
      body: JSON.stringify({
        amount: 10,
        token: 'USDC',
        orderId: `ORDER-${Date.now()}`,
      }),
    });
    const sessionData: any = await createSessionRes.json();
    const sessionId = sessionData.id;

    assert(createSessionRes.status === 201 && sessionId,
      `Created checkout session (id: ${sessionId})`);

    // Step 2: Attempt execute WITHOUT customer wallet authentication -> MUST FAIL 401
    const unauthExecuteRes = await fetch(`${API_BASE}/checkout/sessions/${sessionId}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        buyerWallet: '11111111111111111111111111111111',
        inputToken: 'USDC',
        inputAmount: 10,
      }),
    });
    const unauthExecuteData: any = await unauthExecuteRes.json();
    assert(unauthExecuteRes.status === 401 && unauthExecuteData.error?.includes('Customer wallet authentication required'),
      `Execute payment without customer signature is strictly rejected (HTTP ${unauthExecuteRes.status}, error: "${unauthExecuteData.error}")`);

    // Step 3: Customer requests session nonce
    const buyerKeypair = Keypair.generate();
    const buyerWallet = buyerKeypair.publicKey.toBase58();

    const nonceRes = await fetch(`${API_BASE}/checkout/sessions/${sessionId}/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerWallet: buyerWallet }),
    });
    const nonceData: any = await nonceRes.json();
    assert(nonceRes.status === 200 && nonceData.nonce && nonceData.message,
      `Customer receives checkout nonce challenge (message: "${nonceData.message?.slice(0, 30)}...")`);

    // Step 4: Customer attempts invalid signature -> MUST FAIL 401
    const invalidBuyerVerify = await fetch(`${API_BASE}/checkout/sessions/${sessionId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerWallet: buyerWallet,
        message: nonceData.message,
        signature: 'fake_signature_bytes_base64',
      }),
    });
    assert(invalidBuyerVerify.status === 401,
      `Invalid customer signature rejected (HTTP ${invalidBuyerVerify.status})`);

    // Step 5: Customer signs challenge with real wallet
    const freshNonceRes = await fetch(`${API_BASE}/checkout/sessions/${sessionId}/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerWallet: buyerWallet }),
    });
    const freshNonceData: any = await freshNonceRes.json();
    const buyerMsgBytes = new TextEncoder().encode(freshNonceData.message);
    const buyerSig = nacl.sign.detached(buyerMsgBytes, buyerKeypair.secretKey);
    const buyerSigBase64 = Buffer.from(buyerSig).toString('base64');

    const buyerVerifyRes = await fetch(`${API_BASE}/checkout/sessions/${sessionId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerWallet: buyerWallet,
        message: freshNonceData.message,
        signature: buyerSigBase64,
      }),
    });
    const buyerVerifyData: any = await buyerVerifyRes.json();
    assert(buyerVerifyRes.status === 200 && buyerVerifyData.verified && buyerVerifyData.customerToken,
      `Customer wallet signature verified on backend (customerToken issued)`);

    // Step 6: Verify customer nonce is single-use
    const replayBuyerVerify = await fetch(`${API_BASE}/checkout/sessions/${sessionId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerWallet: buyerWallet,
        message: freshNonceData.message,
        signature: buyerSigBase64,
      }),
    });
    assert(replayBuyerVerify.status === 400,
      `Customer nonce replay rejected (HTTP ${replayBuyerVerify.status})`);

    // Step 7: Check session status now shows customerVerified = true
    const statusRes = await fetch(`${API_BASE}/checkout/sessions/${sessionId}`);
    const sessionDetails: any = await statusRes.json();
    assert(sessionDetails.customerVerified === true,
      `Checkout session status reports customerVerified: true`);
  }

  console.log(`\n=========================================`);
  console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log(`=========================================`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
