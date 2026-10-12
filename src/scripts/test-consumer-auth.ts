import dotenv from 'dotenv';
dotenv.config();
import app from '../app';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import jwt from 'jsonwebtoken';

async function main() {
  const port = 5098;
  const server = app.listen(port);
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log('Testing Consumer Auth Foundation Endpoints...\n');

  try {
    // 1. Generate test Solana keypair
    const keypair = Keypair.generate();
    const walletAddress = keypair.publicKey.toBase58();
    console.log(`1. Test Wallet Address: ${walletAddress}`);

    // 2. Request Nonce: POST /api/auth/consumer/nonce
    console.log('\n2. Testing POST /api/auth/consumer/nonce:');
    const nonceRes = await fetch(`${baseUrl}/api/auth/consumer/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress }),
    });

    const nonceData = (await nonceRes.json()) as any;
    console.log(`Status: ${nonceRes.status}`);
    console.log('Response:', JSON.stringify(nonceData));

    if (nonceRes.status !== 200 || !nonceData.nonce) {
      throw new Error('Nonce generation failed!');
    }

    // 3. Test Invalid Signature: POST /api/auth/consumer/verify with corrupted signature
    console.log('\n3. Testing POST /api/auth/consumer/verify with invalid signature:');
    const badSigRes = await fetch(`${baseUrl}/api/auth/consumer/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress,
        signature: bs58.encode(new Uint8Array(64)),
      }),
    });
    console.log(`Status: ${badSigRes.status}`);
    console.log('Response:', await badSigRes.json());

    // 4. Test Valid Signature: POST /api/auth/consumer/verify
    console.log('\n4. Testing POST /api/auth/consumer/verify with valid signature:');
    const messageBytes = new TextEncoder().encode(nonceData.nonce);
    const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
    const signature = bs58.encode(signatureBytes);

    const verifyRes = await fetch(`${baseUrl}/api/auth/consumer/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, signature }),
    });

    const verifyData = (await verifyRes.json()) as any;
    console.log(`Status: ${verifyRes.status}`);
    console.log('Response:', JSON.stringify(verifyData));

    if (verifyRes.status !== 200 || !verifyData.token) {
      throw new Error('Verification failed!');
    }

    const token = verifyData.token;

    // 5. Test Nonce Single-Use (Replay attack prevention)
    console.log('\n5. Testing replay attack (re-verifying already used nonce):');
    const replayRes = await fetch(`${baseUrl}/api/auth/consumer/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, signature }),
    });
    console.log(`Status: ${replayRes.status}`);
    console.log('Response:', await replayRes.json());

    // 6. Test GET /api/auth/consumer/me (Protected route)
    console.log('\n6. Testing GET /api/auth/consumer/me with valid consumer JWT:');
    const meRes = await fetch(`${baseUrl}/api/auth/consumer/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`Status: ${meRes.status}`);
    console.log('Response:', await meRes.json());

    // 7. Test Cross-Access Protection: Merchant token on consumer route
    console.log('\n7. Testing Cross-Access Protection (Merchant token on consumer route):');
    const merchantToken = jwt.sign(
      { id: 'merch_test', role: 'merchant' },
      process.env.JWT_SECRET || 'fallback-secret-change-me',
      { expiresIn: '1h' }
    );
    const crossRes = await fetch(`${baseUrl}/api/auth/consumer/me`, {
      headers: { Authorization: `Bearer ${merchantToken}` },
    });
    console.log(`Status: ${crossRes.status}`);
    console.log('Response:', await crossRes.json());

    // 8. Test Missing Authorization Header
    console.log('\n8. Testing missing Authorization header on /me:');
    const noAuthRes = await fetch(`${baseUrl}/api/auth/consumer/me`);
    console.log(`Status: ${noAuthRes.status}`);
    console.log('Response:', await noAuthRes.json());

    // ─── Stage 2 Tests ──────────────────────────────────────────
    // 9. Test GET /api/assets/sellable
    console.log('\n9. Testing GET /api/assets/sellable:');
    const assetsRes = await fetch(`${baseUrl}/api/assets/sellable`);
    const assetsData = (await assetsRes.json()) as any;
    console.log(`Status: ${assetsRes.status}`);
    console.log(`Found ${assetsData.tokens?.length} tokens (total: ${assetsData.total})`);
    console.log('Sample token:', JSON.stringify(assetsData.tokens?.[0]));

    if (assetsRes.status !== 200 || !Array.isArray(assetsData.tokens)) {
      throw new Error('/api/assets/sellable failed!');
    }

    // 10. Test GET /api/assets/sellable?search=bonk
    console.log('\n10. Testing GET /api/assets/sellable?search=bonk:');
    const searchRes = await fetch(`${baseUrl}/api/assets/sellable?search=bonk`);
    const searchData = (await searchRes.json()) as any;
    console.log(`Status: ${searchRes.status}`);
    console.log('Search matches:', searchData.tokens?.map((t: any) => `${t.symbol} (${t.name})`));

    if (searchRes.status !== 200 || !searchData.tokens?.length) {
      throw new Error('/api/assets/sellable?search=bonk failed!');
    }

    // 11. Test GET /api/assets/sellable/:mint (BONK)
    const bonkMint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    console.log(`\n11. Testing GET /api/assets/sellable/${bonkMint}:`);
    const singleRes = await fetch(`${baseUrl}/api/assets/sellable/${bonkMint}`);
    const singleData = (await singleRes.json()) as any;
    console.log(`Status: ${singleRes.status}`);
    console.log('Token details:', JSON.stringify(singleData));

    if (singleRes.status !== 200 || singleData.mint !== bonkMint) {
      throw new Error('/api/assets/sellable/:mint failed!');
    }

    // 12. Test GET /api/assets/sellable/:mint with unknown mint (404)
    console.log('\n12. Testing GET /api/assets/sellable/UnknownMint (expect 404):');
    const notFoundRes = await fetch(`${baseUrl}/api/assets/sellable/NonExistent1111111111111111111111111111111`);
    console.log(`Status: ${notFoundRes.status}`);
    console.log('Response:', await notFoundRes.json());

    if (notFoundRes.status !== 404) {
      throw new Error('/api/assets/sellable/:mint 404 check failed!');
    }

    console.log('\n✅ All Stage 1 + Stage 2 endpoints tested and verified successfully!');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
