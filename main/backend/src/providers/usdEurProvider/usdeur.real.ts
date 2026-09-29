import {
  UsdEurAdapter,
  UsdEurFiatQuoteParams,
  UsdEurFiatQuoteResult,
  UsdEurVerifyBankAccountParams,
  UsdEurVerifyBankAccountResult,
  BankInfo,
  ExecutePayoutParams,
  ExecutePayoutResult,
} from './usdeur.adapter';

/**
 * USD/EUR Real Provider Stub (Stage 9)
 * In Stage 9, this will integrate with Transak / Ramp Network APIs.
 */
export const UsdEurReal: UsdEurAdapter = {
  async getFiatQuote(params: UsdEurFiatQuoteParams): Promise<UsdEurFiatQuoteResult> {
    throw new Error('USD/EUR real provider not implemented yet (Stage 9). Please set USE_MOCK_PROVIDERS=true.');
  },

  async verifyBankAccount(params: UsdEurVerifyBankAccountParams): Promise<UsdEurVerifyBankAccountResult> {
    throw new Error('USD/EUR real provider not implemented yet (Stage 9). Please set USE_MOCK_PROVIDERS=true.');
  },

  async listBanks(currency?: 'USD' | 'EUR'): Promise<BankInfo[]> {
    throw new Error('USD/EUR real provider not implemented yet (Stage 9). Please set USE_MOCK_PROVIDERS=true.');
  },

  async executePayout(params: ExecutePayoutParams): Promise<ExecutePayoutResult> {
    throw new Error('USD/EUR real provider not implemented yet (Stage 9). Please set USE_MOCK_PROVIDERS=true.');
  },
};
