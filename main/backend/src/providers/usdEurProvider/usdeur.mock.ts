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
import { ProviderError } from '../../errors/AppError';

const MOCK_USD_EUR_BANKS: BankInfo[] = [
  { name: 'JPMorgan Chase', code: '021000021' },
  { name: 'Bank of America', code: '026009593' },
  { name: 'Wells Fargo', code: '121000247' },
  { name: 'Citibank', code: '021000089' },
  { name: 'Barclays', code: 'BARCGB22' },
  { name: 'Deutsche Bank', code: 'DEUTDEDD' },
  { name: 'BNP Paribas', code: 'BNPAFRPP' },
  { name: 'Revolut', code: 'REVOGB21' },
];

export const UsdEurMock: UsdEurAdapter = {
  async getFiatQuote({ cryptoAmount, fiatCurrency }: UsdEurFiatQuoteParams): Promise<UsdEurFiatQuoteResult> {
    const rate = fiatCurrency === 'EUR' ? 0.92 : 1.0;
    const fiat = Number(cryptoAmount) * rate;

    return {
      fiatAmount: fiat.toFixed(2),
      rate: rate.toString(),
      fee: (fiat * 0.005).toFixed(2),
    };
  },

  async verifyBankAccount({ accountNumber, bankCode }: UsdEurVerifyBankAccountParams): Promise<UsdEurVerifyBankAccountResult> {
    const foundBank = MOCK_USD_EUR_BANKS.find((b) => b.code === bankCode);
    const bankName = foundBank ? foundBank.name : 'JPMorgan Chase';

    return {
      accountName: 'UDUAK GABRIEL AKPAN',
      accountNumber,
      bankName,
    };
  },

  async listBanks(currency?: 'USD' | 'EUR'): Promise<BankInfo[]> {
    return MOCK_USD_EUR_BANKS;
  },

  async executePayout(params: ExecutePayoutParams): Promise<ExecutePayoutResult> {
    const delayMs = process.env.NODE_ENV === 'test' ? 20 : parseInt(process.env.MOCK_PAYOUT_DELAY_MS || '5000', 10);
    await new Promise((r) => setTimeout(r, delayMs));

    const failureRate = parseFloat(process.env.MOCK_FAILURE_RATE || '0.05');
    if (process.env.MOCK_FORCE_PAYOUT_FAIL === 'true' || Math.random() < failureRate) {
      throw new ProviderError('Simulated USD/EUR payout failure', 'usdeur-mock');
    }

    return {
      payoutRefId: `mock_payout_usdeur_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      status: 'COMPLETED',
    };
  },
};
