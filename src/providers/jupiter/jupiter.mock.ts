import {
  JupiterAdapter,
  JupiterSwapQuoteParams,
  JupiterSwapQuoteResult,
  BuildSwapTxParams,
  BuildSwapTxResult,
  SubmitSwapResult,
} from './jupiter.adapter';
import { ProviderError } from '../../errors/AppError';

export const JupiterMock: JupiterAdapter = {
  async getSwapQuote({ inputMint, outputMint, amount, slippageBps }: JupiterSwapQuoteParams): Promise<JupiterSwapQuoteResult> {
    const numAmount = Number(amount) || 0;

    let rate = 0.0000152;
    if (inputMint === outputMint || inputMint.includes('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')) {
      rate = 1.0;
    } else if (inputMint.includes('So11111111111111111111111111111111111111112')) {
      rate = 140.0;
    }

    const calculatedOut = (numAmount * rate).toFixed(6);

    return {
      inputMint,
      outputMint,
      inAmount: amount,
      outAmount: calculatedOut,
      priceImpactPct: 0.05,
      route: {
        mock: true,
        steps: [`${inputMint} → ${outputMint}`],
        swap: `${inputMint.slice(0, 4)}... → ${outputMint.slice(0, 4)}...`,
        provider: 'Jupiter',
      },
    };
  },

  async buildSwapTransaction(params: BuildSwapTxParams): Promise<BuildSwapTxResult> {
    const failureRate = parseFloat(process.env.MOCK_FAILURE_RATE || '0.05');
    // If explicitly forced failure or random failure outside tests
    if (process.env.MOCK_FORCE_SWAP_BUILD_FAIL === 'true' || (Math.random() < failureRate && process.env.NODE_ENV !== 'test')) {
      throw new ProviderError('Simulated swap build failure', 'jupiter-mock');
    }

    const mockTx = Buffer.from(
      JSON.stringify({
        type: 'mock_jupiter_swap',
        sourceMint: params.sourceMint,
        destinationMint: params.destinationMint,
        amount: params.amount,
        userPublicKey: params.userPublicKey,
        timestamp: Date.now(),
      })
    ).toString('base64');

    return {
      serializedTransaction: mockTx,
    };
  },

  async submitSwap(signedTransaction: string): Promise<SubmitSwapResult> {
    const delayMs = process.env.NODE_ENV === 'test' ? 10 : parseInt(process.env.MOCK_DELAY_MS || '2000', 10);
    await new Promise((r) => setTimeout(r, delayMs));

    const failureRate = parseFloat(process.env.MOCK_FAILURE_RATE || '0.05');
    if (process.env.MOCK_FORCE_SWAP_FAIL === 'true' || Math.random() < failureRate) {
      throw new ProviderError('Simulated swap failure', 'jupiter-mock');
    }

    return {
      txHash: `mock_swap_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    };
  },
};
