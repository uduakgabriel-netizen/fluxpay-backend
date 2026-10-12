import { AlertService } from '../../services/alert.service';

// Mock fetch completely
global.fetch = jest.fn();
const mockFetch = global.fetch as jest.Mock;

describe('AlertService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DISCORD_WEBHOOK_URL = 'http://test.webhook';
  });

  afterEach(() => {
    delete process.env.DISCORD_WEBHOOK_URL;
  });


  it('sends swap failure alert', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await AlertService.alertSwapFailure('pay_123', 'Slippage exceeded', 5);
    
    expect(mockFetch).toHaveBeenCalled();
    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.embeds[0].title).toBe('❌ Swap Failure');
  });

  it('sends RPC failover alert', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await AlertService.alertRpcFailover('http://bad.rpc', 'http://good.rpc', 'Connection timed out');
    
    expect(mockFetch).toHaveBeenCalled();
    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.embeds[0].title).toBe('🔌 RPC Failover Triggered');
  });
  
  it('handles fetch errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('Network offline'));
    await expect(AlertService.alertSwapFailure('pay_123', 'err', 1)).resolves.not.toThrow();
  });
});
