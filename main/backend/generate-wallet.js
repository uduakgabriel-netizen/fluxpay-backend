const { Keypair } = require('@solana/web3.js');
const fs = require('fs');

// Generate a new keypair
const keypair = Keypair.generate();

// Get the secret key as an array
const secretKey = Array.from(keypair.secretKey);

// Save to file (optional)
fs.writeFileSync('fluxpay-wallet.json', JSON.stringify(secretKey));

// Output results
console.log('✅ Wallet generated successfully!\n');
console.log('PUBLIC KEY:', '6pM45y8uuKyZBs92HM9npp5MufzzJoPQvKbUXwWGE5sL');
console.log('\nPRIVATE KEY (base64):', 'DPnTXWuXSnQgRhw7shRtzyYpA8UILDwuFLIsHuatwFBWa2gpmvdNkNg/b+6/VVnbEdPOWrbM5RPmlDG/TtVmjw==');
console.log('\n✅ Saved to: fluxpay-wallet.json');