import {
  JupiterAdapter,
  JupiterSwapQuoteParams,
  JupiterSwapQuoteResult,
  BuildSwapTxParams,
  BuildSwapTxResult,
  SubmitSwapResult,
} from './jupiter.adapter';

/**
 * Jupiter Real Provider Stub (Stage 9)
 * In Stage 9, this will integrate with Jupiter Swap API / lite-api.jup.ag
 */
export const JupiterReal: JupiterAdapter = {
  async getSwapQuote(params: JupiterSwapQuoteParams): Promise<JupiterSwapQuoteResult> {
    throw new Error('Jupiter real provider not implemented yet (Stage 9). Please set USE_MOCK_PROVIDERS=true.');
  },

  async buildSwapTransaction(params: BuildSwapTxParams): Promise<BuildSwapTxResult> {
    throw new Error('Jupiter real provider not implemented yet (Stage 9). Please set USE_MOCK_PROVIDERS=true.');
  },

  async submitSwap(signedTransaction: string): Promise<SubmitSwapResult> {
    throw new Error('Jupiter real provider not implemented yet (Stage 9). Please set USE_MOCK_PROVIDERS=true.');
  },
};
