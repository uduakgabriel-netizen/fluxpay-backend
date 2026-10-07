export interface UsdEurFiatQuoteParams {
  cryptoAmount: string; // USDC amount
  fiatCurrency: 'USD' | 'EUR';
}

export interface UsdEurFiatQuoteResult {
  fiatAmount: string;
  rate: string;
  fee: string;
}

export interface UsdEurVerifyBankAccountParams {
  accountNumber: string;
  bankCode: string;
  currency?: 'USD' | 'EUR';
}

export interface UsdEurVerifyBankAccountResult {
  accountName: string;
  accountNumber: string;
  bankName: string;
}

export interface BankInfo {
  name: string;
  code: string;
}

export interface ExecutePayoutParams {
  amount: string;
  currency: string;
  bankAccountId?: string;
  accountNumber: string;
  bankCode?: string;
  accountName?: string;
  reference?: string;
}

export interface ExecutePayoutResult {
  payoutRefId: string;
  status: 'COMPLETED';
}

export interface UsdEurAdapter {
  getFiatQuote(params: UsdEurFiatQuoteParams): Promise<UsdEurFiatQuoteResult>;
  verifyBankAccount(params: UsdEurVerifyBankAccountParams): Promise<UsdEurVerifyBankAccountResult>;
  listBanks(currency?: 'USD' | 'EUR'): Promise<BankInfo[]>;
  executePayout(params: ExecutePayoutParams): Promise<ExecutePayoutResult>;
}
