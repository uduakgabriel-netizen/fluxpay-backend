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
import { logger } from '../../utils/logger';

const UNAVAILABLE_MSG = 'USD/EUR off-ramp not yet available. Coming soon.';

export const UsdEurReal: UsdEurAdapter = {
  async getFiatQuote(params: UsdEurFiatQuoteParams): Promise<UsdEurFiatQuoteResult> {
    const rate = params.fiatCurrency === 'EUR' ? 0.92 : 1.0;
    const fiat = Number(params.cryptoAmount) * rate;
    return {
      fiatAmount: fiat.toFixed(2),
      rate: rate.toString(),
      fee: (fiat * 0.005).toFixed(2),
    };
  },

  async verifyBankAccount(params: UsdEurVerifyBankAccountParams): Promise<UsdEurVerifyBankAccountResult> {
    logger.warn(`[UsdEurReal] Attempted verifyBankAccount for ${params.accountNumber}: ${UNAVAILABLE_MSG}`);
    throw new Error(UNAVAILABLE_MSG);
  },

  async listBanks(currency?: 'USD' | 'EUR'): Promise<BankInfo[]> {
    logger.warn(`[UsdEurReal] Attempted listBanks for ${currency || 'USD/EUR'}: ${UNAVAILABLE_MSG}`);
    throw new Error(UNAVAILABLE_MSG);
  },

  async executePayout(params: ExecutePayoutParams): Promise<ExecutePayoutResult> {
    logger.warn(`[UsdEurReal] Attempted executePayout for ${params.currency}: ${UNAVAILABLE_MSG}`);
    throw new Error(UNAVAILABLE_MSG);
  },
};
