import bs58 from 'bs58';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str: string): Uint8Array {
  const bytes: number[] = [0];

  for (const char of str) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base58 character: ${char}`);
    }

    let carry = index;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Handle leading '1's
  for (const char of str) {
    if (char !== '1') break;
    bytes.push(0);
  }

  return new Uint8Array(bytes.reverse());
}

const testAddress = 'So11111111111111111111111111111111111111112';
try {
  const official = bs58.decode(testAddress);
  const custom = base58Decode(testAddress);
  
  console.log('Official length:', official.length);
  console.log('Custom length:', custom.length);
  
  let matches = true;
  if (official.length !== custom.length) {
    matches = false;
  } else {
    for (let i = 0; i < official.length; i++) {
      if (official[i] !== custom[i]) {
        matches = false;
        break;
      }
    }
  }
  console.log('Match?', matches);
  if (!matches) {
    console.log('Official:', Buffer.from(official).toString('hex'));
    console.log('Custom:', Buffer.from(custom).toString('hex'));
  }
} catch (err: any) {
  console.error('Error:', err.message);
}
