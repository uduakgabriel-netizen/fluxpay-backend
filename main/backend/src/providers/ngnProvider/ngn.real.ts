import {
  NgnAdapter,
  NgnFiatQuoteParams,
  NgnFiatQuoteResult,
  NgnVerifyBankAccountParams,
  NgnVerifyBankAccountResult,
  BankInfo,
  ExecutePayoutParams,
  ExecutePayoutResult,
} from './ngn.adapter';

/**
 * NGN Real Provider Stub (Stage 9)
 * In Stage 9, this will integrate with Breet / OneLiquidity / Busha APIs.
 */
export const NgnReal: NgnAdapter = {
  async getFiatQuote(params: NgnFiatQuoteParams): Promise<NgnFiatQuoteResult> {
    throw new Error('NGN real provider not implemented yet (Stage 9). Please set USE_MOCK_PROVIDERS=true.');
  },

  async verifyBankAccount(params: NgnVerifyBankAccountParams): Promise<NgnVerifyBankAccountResult> {
    throw new Error('NGN real provider not implemented yet (Stage 9). Please set USE_MOCK_PROVIDERS=true.');
  },

  async listBanks(): Promise<BankInfo[]> {
    throw new Error('NGN real provider not implemented yet (Stage 9). Please set USE_MOCK_PROVIDERS=true.');
  },

  async executePayout(params: ExecutePayoutParams): Promise<ExecutePayoutResult> {
    throw new Error('NGN real provider not implemented yet (Stage 9). Please set USE_MOCK_PROVIDERS=true.');
  },
};
