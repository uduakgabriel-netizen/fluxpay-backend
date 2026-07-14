import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    console.log('Querying merchants...');
    const merchants = await prisma.merchant.findMany();
    console.log('Merchants count:', merchants.length);
    console.log('Merchants:', merchants);

    console.log('Querying nonces...');
    const nonces = await prisma.nonce.findMany();
    console.log('Nonces count:', nonces.length);

    console.log('Querying sessions...');
    const sessions = await prisma.session.findMany();
    console.log('Sessions count:', sessions.length);
  } catch (err: any) {
    console.error('Database query failed:', err.message || err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
