import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const testWallet = '6pM45y8uuKyZBs92HM9npp5MufzzJoPQvKbUXwWGE5sL';

  // Check if merchant already exists
  let merchant = await prisma.merchant.findUnique({
    where: { walletAddress: testWallet },
  });

  if (merchant) {
    console.log('Test merchant already exists:', merchant.id);
  } else {
    // Create test merchant
    merchant = await prisma.merchant.create({
      data: {
        walletAddress: testWallet,
        email: 'testmerchant@fluxpay.com',
        businessName: 'Test Merchant',
        emailVerified: true,
        preferredTokenSymbol: 'USDC',
        preferredTokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        hasSelectedToken: true,
      },
    });
    console.log('Created test merchant:', merchant.id);
  }

  console.log('Test merchant ID for auth bypass:', merchant.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
