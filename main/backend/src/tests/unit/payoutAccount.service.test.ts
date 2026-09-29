import { PayoutAccountService } from '../../services/payoutAccount.service';
import { decrypt, encrypt, maskAccountNumber } from '../../utils/encryption';

describe('Payout Account Service & Security (Stage 4 Unit Tests)', () => {
  beforeAll(() => {
    process.env.USE_MOCK_PROVIDERS = 'true';
    if (!process.env.ENCRYPTION_KEY) {
      process.env.ENCRYPTION_KEY = 'fe6b795d7ba1fb5f4243777e583066d35fd2901f51c7f401488c1c47dce47c05';
    }
  });

  describe('Encryption & Masking Utilities', () => {
    it('encrypts plaintext account number and successfully decrypts it back', () => {
      const plaintext = '0801234589';
      const ciphertext = encrypt(plaintext);
      expect(ciphertext).not.toEqual(plaintext);
      expect(typeof ciphertext).toBe('string');

      const decrypted = decrypt(ciphertext);
      expect(decrypted).toEqual(plaintext);
    });

    it('masks account number according to standard format (first 3 + last 2 visible)', () => {
      const masked = maskAccountNumber('0801234589');
      expect(masked).toBe('080******89');
      expect(masked.startsWith('080')).toBe(true);
      expect(masked.endsWith('89')).toBe(true);
      expect(masked).toContain('******');
    });
  });

  describe('Bank Listing & Verification', () => {
    it('returns supported banks list without requiring authentication', async () => {
      const res = await PayoutAccountService.listBanks({ currency: 'NGN' });
      expect(res.banks).toBeDefined();
      expect(res.banks.length).toBeGreaterThan(0);
      expect(res.total).toBe(res.banks.length);

      const opay = res.banks.find((b: any) => b.code === '999992');
      expect(opay).toBeDefined();
      expect(opay.name).toBe('OPay');
    });

    it('verifies valid 10-digit Nigerian bank account', async () => {
      const verified = await PayoutAccountService.verifyAccount({
        accountNumber: '0801234589',
        bankCode: '999992',
        currency: 'NGN',
      });

      expect(verified.verified).toBe(true);
      expect(verified.accountName).toBe('UDUAK GABRIEL AKPAN');
      expect(verified.accountNumber).toBe('0801234589');
      expect(verified.bankName).toBe('OPay');
    });

    it('rejects invalid account number lengths for NGN', async () => {
      await expect(
        PayoutAccountService.verifyAccount({
          accountNumber: '12345',
          bankCode: '999992',
          currency: 'NGN',
        })
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('Account Creation & Encryption in DB', () => {
    const consumerActor = { type: 'consumer' as const, id: 'consumer_user_abc' };

    it('creates account, encrypts account number, and returns masked response', async () => {
      const account = await PayoutAccountService.createAccount({
        accountNumber: '0801234589',
        bankCode: '999992',
        bankName: 'OPay',
        currency: 'NGN',
        accountName: 'UDUAK GABRIEL AKPAN',
        setDefault: true,
        actor: consumerActor,
      });

      expect(account.id).toMatch(/^acct_/);
      expect(account.accountName).toBe('UDUAK GABRIEL AKPAN');
      expect(account.bankName).toBe('OPay');
      expect(account.isVerified).toBe(true);
      expect(account.isDefault).toBe(true);

      // CRITICAL: Account number must be masked in API output
      expect(account.accountNumber).toBe('080******89');
      expect(account.accountNumber).not.toBe('0801234589');
    });

    it('maintains strict owner isolation (cross-user access blocked)', async () => {
      const otherActor = { type: 'consumer' as const, id: 'different_user_xyz' };

      const created = await PayoutAccountService.createAccount({
        accountNumber: '0123456789',
        bankCode: '058',
        bankName: 'GTBank',
        currency: 'NGN',
        accountName: 'UDUAK GABRIEL AKPAN',
        actor: consumerActor,
      });

      // Different user cannot access this account
      await expect(PayoutAccountService.getAccountById(created.id, otherActor)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('handles default account swapping and deletion promotion', async () => {
      const testActor = { type: 'consumer' as const, id: 'user_default_test' };

      // Account 1 (default)
      const acct1 = await PayoutAccountService.createAccount({
        accountNumber: '0111111111',
        bankCode: '999992',
        bankName: 'OPay',
        currency: 'NGN',
        accountName: 'TEST USER',
        setDefault: true,
        actor: testActor,
      });
      expect(acct1.isDefault).toBe(true);

      // Account 2 set as new default
      const acct2 = await PayoutAccountService.createAccount({
        accountNumber: '0222222222',
        bankCode: '058',
        bankName: 'GTBank',
        currency: 'NGN',
        accountName: 'TEST USER',
        setDefault: true,
        actor: testActor,
      });
      expect(acct2.isDefault).toBe(true);

      // Account 1 should no longer be default
      const refreshedAcct1 = await PayoutAccountService.getAccountById(acct1.id, testActor);
      expect(refreshedAcct1.isDefault).toBe(false);

      // Delete current default (Account 2) -> Account 1 should automatically be promoted to default
      await PayoutAccountService.deleteAccount(acct2.id, testActor);
      const promotedAcct1 = await PayoutAccountService.getAccountById(acct1.id, testActor);
      expect(promotedAcct1.isDefault).toBe(true);
    });
  });
});
