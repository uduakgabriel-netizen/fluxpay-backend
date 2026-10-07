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
    logger.warn(`[UsdEurReal] Attempted getFiatQuote for ${params.fiatCurrency}: ${UNAVAILABLE_MSG}`);
    throw new Error(UNAVAILABLE_MSG);
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
