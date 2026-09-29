export interface NgnFiatQuoteParams {
  cryptoAmount: string; // USDC amount
  fiatCurrency: 'NGN';
}

export interface NgnFiatQuoteResult {
  fiatAmount: string;
  rate: string;
  fee: string;
}

export interface NgnVerifyBankAccountParams {
  accountNumber: string;
  bankCode: string;
}

export interface NgnVerifyBankAccountResult {
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

export interface NgnAdapter {
  getFiatQuote(params: NgnFiatQuoteParams): Promise<NgnFiatQuoteResult>;
  verifyBankAccount(params: NgnVerifyBankAccountParams): Promise<NgnVerifyBankAccountResult>;
  listBanks(): Promise<BankInfo[]>;
  executePayout(params: ExecutePayoutParams): Promise<ExecutePayoutResult>;
}
