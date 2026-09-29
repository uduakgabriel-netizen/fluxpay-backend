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
import { ProviderError } from '../../errors/AppError';

const MOCK_NGN_BANKS: BankInfo[] = [
  { name: 'OPay', code: '999992' },
  { name: 'PalmPay', code: '999991' },
  { name: 'Kuda Bank', code: '50211' },
  { name: 'Moniepoint', code: '50515' },
  { name: 'Guaranty Trust Bank (GTBank)', code: '058' },
  { name: 'Access Bank', code: '044' },
  { name: 'Zenith Bank', code: '057' },
  { name: 'First Bank of Nigeria', code: '011' },
  { name: 'United Bank for Africa (UBA)', code: '033' },
  { name: 'Fidelity Bank', code: '070' },
  { name: 'Stanbic IBTC Bank', code: '221' },
  { name: 'Sterling Bank', code: '232' },
  { name: 'Union Bank of Nigeria', code: '032' },
  { name: 'Wema Bank', code: '035' },
];

export const NgnMock: NgnAdapter = {
  async getFiatQuote({ cryptoAmount, fiatCurrency }: NgnFiatQuoteParams): Promise<NgnFiatQuoteResult> {
    // Simulated: 1 USDC = 1,523 NGN
    const rate = 1523;
    const fiat = Number(cryptoAmount) * rate;
    return {
      fiatAmount: fiat.toFixed(2),
      rate: rate.toString(),
      fee: (fiat * 0.005).toFixed(2),
    };
  },

  async verifyBankAccount({ accountNumber, bankCode }: NgnVerifyBankAccountParams): Promise<NgnVerifyBankAccountResult> {
    const foundBank = MOCK_NGN_BANKS.find((b) => b.code === bankCode);
    const bankName = foundBank ? foundBank.name : 'OPay';

    return {
      accountName: 'UDUAK GABRIEL AKPAN',
      accountNumber,
      bankName,
    };
  },

  async listBanks(): Promise<BankInfo[]> {
    return MOCK_NGN_BANKS;
  },

  async executePayout(params: ExecutePayoutParams): Promise<ExecutePayoutResult> {
    const delayMs = process.env.NODE_ENV === 'test' ? 20 : parseInt(process.env.MOCK_PAYOUT_DELAY_MS || '5000', 10);
    await new Promise((r) => setTimeout(r, delayMs));

    const failureRate = parseFloat(process.env.MOCK_FAILURE_RATE || '0.05');
    if (process.env.MOCK_FORCE_PAYOUT_FAIL === 'true' || Math.random() < failureRate) {
      throw new ProviderError('Simulated NGN payout failure', 'ngn-mock');
    }

    return {
      payoutRefId: `mock_payout_ngn_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      status: 'COMPLETED',
    };
  },
};
