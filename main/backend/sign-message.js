const { Keypair } = require('@solana/web3.js');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const fs = require('fs');

// Load your wallet
const keypairData = JSON.parse(fs.readFileSync('fluxpay-wallet.json', 'utf8'));
const secretKey = Uint8Array.from(keypairData);
const keypair = Keypair.fromSecretKey(secretKey);

// The REAL message from 
 const message = `Welcome to FluxPay! Sign this message to verify your wallet. Nonce: 7f9a7072ee866193e40b86600819f33dec60f36e05e2ba7f145a1297d63a6227`;

// Sign the message
const messageBytes = new TextEncoder().encode(message);
const signature = nacl.sign.detached(messageBytes, secretKey);

console.log('message:', message);
console.log('signature:', bs58.encode(signature));
console.log('walletAddress:', keypair.publicKey.toString());