import { checkMerchantSolBalance, processNonCustodialSwapIfNeeded } from '../../services/nonCustodialSwap.service';
import { Connection } from '@solana/web3.js';
import * as solanaConfig from '../../config/solana';

const mockPrismaUpdate = jest.fn().mockResolvedValue({});
const mockPrismaCreate = jest.fn().mockResolvedValue({});

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    payment: {
      update: (...args: any[]) => mockPrismaUpdate(...args),
    },
    paymentEvent: {
      create: (...args: any[]) => mockPrismaCreate(...args),
    },
  })),
}));

jest.mock('../../config/solana', () => ({
  withFailover: jest.fn().mockImplementation((fn) => fn({
    getBalance: jest.fn().mockResolvedValue(10000000), // 0.01 SOL
  })),
  getConnection: jest.fn(),
}));

describe('NonCustodial Swap Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('checks merchant SOL balance successfully', async () => {
    const result = await checkMerchantSolBalance('11111111111111111111111111111111');
    expect(result.sufficient).toBe(true);
    expect(result.balance).toBe(0.01);
  });

  it('fails swap directly if tokens are the same', async () => {
    await processNonCustodialSwapIfNeeded('pay_123', 'cx', 'mx', 'USDC', 10, 'USDC');
    expect(mockPrismaUpdate).toHaveBeenCalled();
    expect(mockPrismaCreate).toHaveBeenCalled();
  });
});
