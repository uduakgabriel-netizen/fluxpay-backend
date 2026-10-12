import { getSwapQuote, buildNonCustodialSwapTx } from '../../services/jupiter.service';

global.fetch = jest.fn();
const mockFetch = global.fetch as jest.Mock;

describe('Jupiter Service (ExactOut)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null for unknown tokens', async () => {
    // Non-existent token for testing early exit — should not even call fetch
    const result = await getSwapQuote('FAKE', 'FAKE2', 10);
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('gets a successful ExactOut quote (amount = desired output)', async () => {
    // ExactOut: amount=1 USDC (6 decimals) → Jupiter receives amount=1000000
    // Jupiter returns inAmount (what buyer pays) and outAmount (what merchant gets)
    mockFetch.mockResolvedValue({
      ok: true,
      clone: function() { return this; },
      text: jest.fn().mockResolvedValue(''),
      json: jest.fn().mockResolvedValue({
        inAmount: '6500000',     // ~0.0065 SOL the buyer must send
        outAmount: '1000000',    // 1 USDC the merchant receives
        swapMode: 'ExactOut',
      }),
    });

    const result = await getSwapQuote('SOL', 'USDC', 1); // Merchant wants 1 USDC
    expect(mockFetch).toHaveBeenCalled();

    // Verify ExactOut is in the URL
    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain('swapMode=ExactOut');
    // Verify amount is in USDC smallest units (1 USDC = 1000000)
    expect(fetchUrl).toContain('amount=1000000');

    expect(result?.outAmount).toBe('1000000');
    expect(result?.inAmount).toBe('6500000');
  });

  it('builds a non-custodial swap transaction', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: jest.fn().mockResolvedValue({ swapTransaction: 'base64tx' }) });
    const result = await buildNonCustodialSwapTx({} as any, 'cust_wallet', 'merch_wallet');
    expect(result).toBe('base64tx');
    
    const reqBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(reqBody.useSharedAccounts).toBe(true);
    expect(reqBody.userPublicKey).toBe('cust_wallet');
    expect(reqBody.destinationTokenAccount).toBe('merch_wallet');
  });
});
