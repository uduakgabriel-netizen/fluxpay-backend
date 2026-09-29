import nacl from 'tweetnacl';
import bs58 from 'bs58';
import supertest from 'supertest';
import app from '../app';
import { decrypt } from '../utils/encryption';

async function runStage3And4Tests() {
  console.log('====================================================');
  console.log('🚀 Running Stage 3 & Stage 4 End-to-End Test Suite');
  console.log('====================================================\n');

  const request = supertest(app);

  // ─────────────────────────────────────────────────────────────
  // 1. Authenticate a Consumer User
  // ─────────────────────────────────────────────────────────────
  console.log('--- Setting up Consumer Authentication ---');
  const consumerKeypair = nacl.sign.keyPair();
  const consumerWalletAddress = bs58.encode(consumerKeypair.publicKey);

  // Nonce
  const nonceRes = await request
    .post('/api/auth/consumer/nonce')
    .send({ walletAddress: consumerWalletAddress });
  if (nonceRes.status !== 200) {
    throw new Error(`Failed to get nonce: ${JSON.stringify(nonceRes.body)}`);
  }
  const nonce = nonceRes.body.nonce;

  // Sign & Verify
  const nonceBytes = Buffer.from(nonce, 'utf8');
  const signatureBytes = nacl.sign.detached(nonceBytes, consumerKeypair.secretKey);
  const signature = bs58.encode(signatureBytes);

  const verifyRes = await request
    .post('/api/auth/consumer/verify')
    .send({ walletAddress: consumerWalletAddress, signature });
  if (verifyRes.status !== 200) {
    throw new Error(`Failed consumer auth verify: ${JSON.stringify(verifyRes.body)}`);
  }
  const consumerToken = verifyRes.body.token;
  const consumerUser = verifyRes.body.user;
  console.log(`✅ Authenticated consumer: ${consumerUser.id} (${consumerWalletAddress})`);

  // Another consumer for cross-user security testing
  const otherKeypair = nacl.sign.keyPair();
  const otherWallet = bs58.encode(otherKeypair.publicKey);
  const otherNonceRes = await request
    .post('/api/auth/consumer/nonce')
    .send({ walletAddress: otherWallet });
  const otherSignature = bs58.encode(
    nacl.sign.detached(Buffer.from(otherNonceRes.body.nonce, 'utf8'), otherKeypair.secretKey)
  );
  const otherVerifyRes = await request
    .post('/api/auth/consumer/verify')
    .send({ walletAddress: otherWallet, signature: otherSignature });
  const otherToken = otherVerifyRes.body.token;

  // ─────────────────────────────────────────────────────────────
  // 2. STAGE 3: QUOTE ENGINE
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Testing Stage 3: Quote Engine ---');

  // Endpoint 1: POST /api/offramp/quote
  console.log('Testing Endpoint 1: POST /api/offramp/quote');
  const quoteReqBody = {
    sourceToken: 'BONK',
    sourceMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    sourceAmount: '10000',
    fiatCurrency: 'NGN',
  };

  const quoteRes = await request
    .post('/api/offramp/quote')
    .set('Authorization', `Bearer ${consumerToken}`)
    .send(quoteReqBody);

  console.log('Quote response status:', quoteRes.status);
  console.log('Quote response body:', JSON.stringify(quoteRes.body, null, 2));

  if (quoteRes.status !== 200 || !quoteRes.body.quoteId) {
    throw new Error(`Quote generation failed: ${JSON.stringify(quoteRes.body)}`);
  }

  const { quoteId, fiatAmount, fee, networkFee, netAmount, route, expiresAt } = quoteRes.body;
  if (!quoteId.startsWith('q_')) {
    throw new Error(`Invalid quoteId prefix: ${quoteId}`);
  }
  if (route.mock !== true || route.provider !== 'OneLiquidity') {
    throw new Error(`Unexpected route details: ${JSON.stringify(route)}`);
  }
  console.log(`✅ Quote generated successfully: ${quoteId}`);
  console.log(`   fiat: ₦${fiatAmount}, fee: ₦${fee}, networkFee: ₦${networkFee}, net: ₦${netAmount}`);

  // Endpoint 2: GET /api/offramp/quote/:quoteId (active quote)
  console.log('\nTesting Endpoint 2: GET /api/offramp/quote/:quoteId');
  const getQuoteRes = await request.get(`/api/offramp/quote/${quoteId}`);
  console.log('Get quote status:', getQuoteRes.status);
  console.log('Get quote body:', JSON.stringify(getQuoteRes.body, null, 2));

  if (getQuoteRes.status !== 200) {
    throw new Error(`Failed to retrieve quote: ${JSON.stringify(getQuoteRes.body)}`);
  }
  if (getQuoteRes.body.isExpired !== false || getQuoteRes.body.secondsRemaining <= 0) {
    throw new Error(`Quote should be active with remaining seconds: ${JSON.stringify(getQuoteRes.body)}`);
  }
  console.log(`✅ Quote retrieval verified: isExpired=${getQuoteRes.body.isExpired}, remaining=${getQuoteRes.body.secondsRemaining}s`);

  // Non-existent quote
  const notFoundQuoteRes = await request.get('/api/offramp/quote/q_nonexistent_123');
  if (notFoundQuoteRes.status !== 404) {
    throw new Error(`Expected 404 for non-existent quote, got ${notFoundQuoteRes.status}`);
  }
  console.log('✅ Non-existent quote returned 404 as expected');

  // ─────────────────────────────────────────────────────────────
  // 3. STAGE 4: PAYOUT ACCOUNT MANAGEMENT
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- Testing Stage 4: Payout Account Management ---');

  // Endpoint 1: GET /api/payout-accounts/banks (public)
  console.log('Testing Endpoint 1: GET /api/payout-accounts/banks (public)');
  const banksRes = await request.get('/api/payout-accounts/banks?country=NG&currency=NGN');
  console.log('Banks status:', banksRes.status, `total: ${banksRes.body.total}`);
  if (banksRes.status !== 200 || !Array.isArray(banksRes.body.banks) || banksRes.body.total === 0) {
    throw new Error(`Banks endpoint failed: ${JSON.stringify(banksRes.body)}`);
  }
  console.log('Sample bank:', banksRes.body.banks[0]);
  console.log('✅ Public banks listing returned 200 with banks array');

  // Endpoint 2: POST /api/payout-accounts/verify
  console.log('\nTesting Endpoint 2: POST /api/payout-accounts/verify');
  const verifyAcctRes = await request
    .post('/api/payout-accounts/verify')
    .set('Authorization', `Bearer ${consumerToken}`)
    .send({
      accountNumber: '0801234589',
      bankCode: '999992',
      currency: 'NGN',
    });

  console.log('Verify account status:', verifyAcctRes.status);
  console.log('Verify account body:', JSON.stringify(verifyAcctRes.body, null, 2));

  if (verifyAcctRes.status !== 200 || !verifyAcctRes.body.verified) {
    throw new Error(`Account verification failed: ${JSON.stringify(verifyAcctRes.body)}`);
  }
  console.log(`✅ Account verified: ${verifyAcctRes.body.accountName} (${verifyAcctRes.body.bankName})`);

  // Invalid account number test
  const invalidAcctRes = await request
    .post('/api/payout-accounts/verify')
    .set('Authorization', `Bearer ${consumerToken}`)
    .send({
      accountNumber: '123',
      bankCode: '999992',
      currency: 'NGN',
    });
  if (invalidAcctRes.status !== 400) {
    throw new Error(`Expected 400 for invalid account number format, got ${invalidAcctRes.status}`);
  }
  console.log('✅ Invalid account format returned 400 as expected');

  // Endpoint 3: POST /api/payout-accounts
  console.log('\nTesting Endpoint 3: POST /api/payout-accounts');
  const saveAcctRes = await request
    .post('/api/payout-accounts')
    .set('Authorization', `Bearer ${consumerToken}`)
    .send({
      accountNumber: '0801234589',
      bankCode: '999992',
      bankName: 'OPay',
      currency: 'NGN',
      accountName: 'UDUAK GABRIEL AKPAN',
      setDefault: true,
    });

  console.log('Save account status:', saveAcctRes.status);
  console.log('Save account body:', JSON.stringify(saveAcctRes.body, null, 2));

  if (saveAcctRes.status !== 201 && saveAcctRes.status !== 200) {
    throw new Error(`Save account failed: ${JSON.stringify(saveAcctRes.body)}`);
  }
  const createdAcctId = saveAcctRes.body.id;
  if (!createdAcctId.startsWith('acct_')) {
    throw new Error(`Expected acct_ prefix: ${createdAcctId}`);
  }
  // MASKING CHECK: Never return full plaintext account number!
  if (saveAcctRes.body.accountNumber === '0801234589' || !saveAcctRes.body.accountNumber.includes('*')) {
    throw new Error(`SECURITY ALERT: Account number was not properly masked: ${saveAcctRes.body.accountNumber}`);
  }
  console.log(`✅ Account created and masked: ${saveAcctRes.body.accountNumber} (ID: ${createdAcctId})`);

  // Add a 2nd account
  const saveAcct2Res = await request
    .post('/api/payout-accounts')
    .set('Authorization', `Bearer ${consumerToken}`)
    .send({
      accountNumber: '0123456789',
      bankCode: '058',
      bankName: 'GTBank',
      currency: 'NGN',
      accountName: 'UDUAK GABRIEL AKPAN',
      setDefault: true, // Now GTBank becomes default
    });
  const createdAcct2Id = saveAcct2Res.body.id;
  console.log(`✅ Second account created: ${saveAcct2Res.body.accountNumber} (New Default)`);

  // Endpoint 4: GET /api/payout-accounts
  console.log('\nTesting Endpoint 4: GET /api/payout-accounts');
  const listAcctsRes = await request
    .get('/api/payout-accounts')
    .set('Authorization', `Bearer ${consumerToken}`);

  console.log('List accounts status:', listAcctsRes.status);
  console.log('List accounts body:', JSON.stringify(listAcctsRes.body, null, 2));

  if (listAcctsRes.status !== 200 || listAcctsRes.body.total < 2) {
    throw new Error(`List accounts failed: ${JSON.stringify(listAcctsRes.body)}`);
  }
  for (const acct of listAcctsRes.body.accounts) {
    if (!acct.accountNumber.includes('*')) {
      throw new Error(`SECURITY ALERT: Unmasked account number in list response: ${acct.accountNumber}`);
    }
  }
  console.log(`✅ List accounts returned ${listAcctsRes.body.total} accounts, all masked.`);

  // Endpoint 5: GET /api/payout-accounts/:id
  console.log('\nTesting Endpoint 5: GET /api/payout-accounts/:id');
  const singleAcctRes = await request
    .get(`/api/payout-accounts/${createdAcctId}`)
    .set('Authorization', `Bearer ${consumerToken}`);

  if (singleAcctRes.status !== 200 || singleAcctRes.body.id !== createdAcctId) {
    throw new Error(`Failed to get single account: ${JSON.stringify(singleAcctRes.body)}`);
  }
  console.log(`✅ Single account retrieval verified: ID=${singleAcctRes.body.id}, masked=${singleAcctRes.body.accountNumber}`);

  // Cross-user access test: Other user should NOT be able to view this account
  const crossUserRes = await request
    .get(`/api/payout-accounts/${createdAcctId}`)
    .set('Authorization', `Bearer ${otherToken}`);

  if (crossUserRes.status !== 403 && crossUserRes.status !== 404) {
    throw new Error(`SECURITY ALERT: Cross-user access not blocked! Expected 403/404, got ${crossUserRes.status}`);
  }
  console.log('✅ Cross-user access strictly blocked (returned 403/404)');

  // Endpoint 6: PATCH /api/payout-accounts/:id
  console.log('\nTesting Endpoint 6: PATCH /api/payout-accounts/:id');
  const patchRes = await request
    .patch(`/api/payout-accounts/${createdAcctId}`)
    .set('Authorization', `Bearer ${consumerToken}`)
    .send({ setDefault: true });

  if (patchRes.status !== 200 || patchRes.body.isDefault !== true) {
    throw new Error(`Patch account failed: ${JSON.stringify(patchRes.body)}`);
  }
  console.log(`✅ Account ${createdAcctId} reset back to default`);

  // Endpoint 7: DELETE /api/payout-accounts/:id
  console.log('\nTesting Endpoint 7: DELETE /api/payout-accounts/:id');
  const deleteRes = await request
    .delete(`/api/payout-accounts/${createdAcctId}`)
    .set('Authorization', `Bearer ${consumerToken}`);

  if (deleteRes.status !== 200 || deleteRes.body.success !== true) {
    throw new Error(`Delete account failed: ${JSON.stringify(deleteRes.body)}`);
  }
  console.log(`✅ Account ${createdAcctId} deleted successfully`);

  // Verify second account became default automatically
  const check2ndAcct = await request
    .get(`/api/payout-accounts/${createdAcct2Id}`)
    .set('Authorization', `Bearer ${consumerToken}`);
  if (check2ndAcct.body.isDefault !== true) {
    throw new Error(`Expected second account to be promoted to default, but isDefault=${check2ndAcct.body.isDefault}`);
  }
  console.log(`✅ Account ${createdAcct2Id} automatically promoted to default`);

  console.log('\n====================================================');
  console.log('🎉 ALL 9 ENDPOINTS TESTED AND FULLY VERIFIED!');
  console.log('====================================================\n');
}

runStage3And4Tests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
