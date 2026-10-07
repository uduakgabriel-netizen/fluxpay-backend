import { PrismaClient, TransactionStatus } from '@prisma/client';
import {
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  QuoteExpiredError,
  ProviderError,
} from '../errors/AppError';
import { assertTransition } from '../utils/transactionStateMachine';
import { retryWithBackoff } from '../utils/retry';
import { getProvider, getPayoutProvider } from '../providers/provider.factory';
import { maskAccountNumber } from '../utils/encryption';
import { logger } from '../utils/logger';
import { QuoteService } from './quote.service';
import { PayoutAccountService } from './payoutAccount.service';
import { randomBytes } from 'crypto';

const prisma = new PrismaClient();

// In-memory fallback for local execution / dev mode without PostgreSQL
export const memoryTransactions = new Map<string, any>();

export interface ActorContext {
  type: 'consumer' | 'merchant';
  id: string;
}

export interface ExecuteOffRampInput {
  quoteId: string;
  bankAccountId: string;
}

export interface SubmitOffRampInput {
  transactionId: string;
  signedTransaction: string;
}

export interface ListTransactionsQuery {
  status?: string;
  limit?: string | number;
  offset?: string | number;
}

export class OfframpExecutionService {
  /**
   * Helper: Fetch Quote with DB + memory fallback
   */
  static async findQuote(quoteId: string) {
    let quote = null;
    try {
      quote = await prisma.quote.findUnique({
        where: { id: quoteId },
      });
    } catch (err) {
      logger.warn(`[OffRamp] DB quote lookup failed, trying QuoteService fallback`);
    }

    if (!quote) {
      const q = await QuoteService.getQuoteById(quoteId);
      if (q) {
        quote = {
          id: q.quoteId,
          userId: (q as any).userId || null,
          merchantId: (q as any).merchantId || null,
          sourceToken: q.sourceToken,
          sourceMint: q.sourceMint,
          sourceAmount: q.sourceAmount,
          intermediateToken: q.intermediateToken,
          intermediateAmount: q.intermediateAmount,
          fiatCurrency: q.fiatCurrency,
          fiatAmount: q.fiatAmount,
          rate: q.rate,
          fee: q.fee,
          networkFee: q.networkFee,
          netAmount: q.netAmount,
          expiresAt: new Date(q.expiresAt),
          used: q.isUsed || false,
        };
      }
    }

    return quote ? { ...quote } : null;
  }

  /**
   * Helper: Fetch Bank Account with DB + memory fallback
   */
  static async findBankAccount(bankAccountId: string, actorId: string) {
    let bankAccount = null;
    try {
      bankAccount = await prisma.bankAccount.findUnique({
        where: { id: bankAccountId },
      });
    } catch (err) {
      logger.warn(`[OffRamp] DB bank account lookup failed, trying PayoutAccountService fallback`);
    }

    if (!bankAccount) {
      try {
        const b = await (PayoutAccountService as any).getAccountById(bankAccountId, { type: 'consumer', id: actorId });
        if (b) {
          bankAccount = {
            id: b.id,
            userId: (b as any).userId || actorId,
            merchantId: (b as any).merchantId || null,
            bankName: b.bankName,
            bankCode: (b as any).bankCode || '',
            accountNumber: b.accountNumber,
            accountName: b.accountName,
            currency: b.currency,
            isVerified: b.isVerified,
            provider: (b as any).provider || 'ngn-mock',
          };
        }
      } catch {
        // If not found or forbidden, bankAccount remains null
      }
    }

    return bankAccount ? { ...bankAccount } : null;
  }

  /**
   * Helper: Fetch Transaction with DB + memory fallback
   */
  static async findTransaction(id: string) {
    let transaction = null;
    try {
      transaction = await prisma.offRampTransaction.findUnique({
        where: { id },
      });
    } catch (err) {
      logger.warn(`[OffRamp] DB transaction lookup failed, trying memory fallback`);
    }

    if (!transaction) {
      transaction = memoryTransactions.get(id) || null;
    }

    return transaction;
  }

  /**
   * Helper: Update Transaction in DB and memory
   */
  static async updateTransaction(id: string, data: any) {
    let updated = null;
    try {
      updated = await prisma.offRampTransaction.update({
        where: { id },
        data,
      });
    } catch (err) {
      logger.warn(`[OffRamp] DB update transaction failed, updating memory fallback`);
    }

    const existing = memoryTransactions.get(id) || {};
    const merged = { ...existing, ...(updated || {}), ...data, updatedAt: new Date() };
    memoryTransactions.set(id, merged);
    return merged;
  }

  /**
   * Endpoint 1: Execute Off-Ramp
   */
  static async execute(actor: ActorContext, input: ExecuteOffRampInput) {
    if (!input || !input.quoteId || !input.bankAccountId) {
      throw new ValidationError('quoteId and bankAccountId are required');
    }

    // 1. Fetch quote
    const quote = await this.findQuote(input.quoteId);
    if (!quote) {
      throw new NotFoundError('Quote');
    }

    // 2. Check quote expiration
    if (new Date() > new Date(quote.expiresAt)) {
      throw new QuoteExpiredError();
    }

    // 3. Check quote used
    if (quote.used) {
      throw new ConflictError('Quote has already been used', 'QUOTE_ALREADY_USED');
    }

    // 4. Fetch bank account
    const bankAccount = await this.findBankAccount(input.bankAccountId, actor.id);
    if (!bankAccount) {
      throw new NotFoundError('Bank account');
    }

    // 5. Validate ownership
    if (actor.type === 'consumer') {
      if (bankAccount.userId && bankAccount.userId !== actor.id) {
        throw new ForbiddenError('Access denied: You do not own this bank account');
      }
      if (quote.userId && quote.userId !== actor.id) {
        throw new ForbiddenError('Access denied: You do not own this quote');
      }
    } else {
      if (bankAccount.merchantId && bankAccount.merchantId !== actor.id) {
        throw new ForbiddenError('Access denied: You do not own this bank account');
      }
      if (quote.merchantId && quote.merchantId !== actor.id) {
        throw new ForbiddenError('Access denied: You do not own this quote');
      }
    }

    // 6. Validate currency match
    if (quote.fiatCurrency !== bankAccount.currency) {
      throw new ValidationError(
        `Bank account currency (${bankAccount.currency}) does not match quote currency (${quote.fiatCurrency})`
      );
    }

    // 7. Validate bank account is verified
    if (!bankAccount.isVerified) {
      throw new ValidationError('Bank account is not verified');
    }

    // 8. Create transaction with status PENDING
    const txId = `tx_${randomBytes(8).toString('hex')}`;
    const txRecord = {
      id: txId,
      quoteId: quote.id,
      userId: actor.type === 'consumer' ? actor.id : null,
      merchantId: actor.type === 'merchant' ? actor.id : null,
      sourceToken: quote.sourceToken,
      sourceMint: quote.sourceMint,
      sourceAmount: quote.sourceAmount,
      intermediateToken: quote.intermediateToken || 'USDC',
      intermediateAmount: quote.intermediateAmount,
      fiatCurrency: quote.fiatCurrency,
      fiatAmount: quote.fiatAmount,
      rate: quote.rate,
      fee: quote.fee,
      networkFee: quote.networkFee,
      netAmount: quote.netAmount,
      status: 'PENDING' as TransactionStatus,
      bankAccountId: bankAccount.id,
      provider: bankAccount.provider || (quote.fiatCurrency === 'NGN' ? 'ngn-mock' : 'usdeur-mock'),
      retryCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    };

    let transaction: any = txRecord;
    try {
      transaction = await prisma.offRampTransaction.create({
        data: txRecord,
      });
    } catch (err) {
      logger.warn('[OffRamp] DB create transaction failed, storing in memory fallback');
    }
    memoryTransactions.set(transaction.id, { ...txRecord, ...transaction });

    // 9. Mark quote as used
    try {
      await prisma.quote.update({
        where: { id: quote.id },
        data: { used: true },
      });
    } catch (err) {
      // Fallback
    }
    await QuoteService.markQuoteUsed(quote.id);
    quote.used = true;

    // 10. Call Jupiter mock adapter to build swap transaction
    let serializedTransaction: string;
    try {
      const jupiter = getProvider('jupiter');
      const buildResult = await retryWithBackoff(
        () =>
          jupiter.buildSwapTransaction({
            sourceMint: quote.sourceMint,
            destinationMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC mint
            amount: quote.sourceAmount,
            userPublicKey: actor.id,
          }),
        { maxAttempts: 3, shouldRetry: (err) => !(err instanceof ValidationError) }
      );
      serializedTransaction = buildResult.serializedTransaction;
    } catch (providerErr: any) {
      // On provider error -> set transaction to FAILED, log error, throw ProviderError
      assertTransition(transaction.status, 'FAILED', 'fail build swap');
      await this.updateTransaction(transaction.id, {
        status: 'FAILED',
        errorCode: 'PROVIDER_ERROR',
        errorMessage: providerErr.message || 'Failed to build swap transaction',
      });
      logger.error('[OffRamp] Provider failure during buildSwapTransaction:', {
        transactionId: transaction.id,
        error: providerErr.message,
      });
      throw new ProviderError(
        providerErr.message || 'Failed to build swap transaction',
        'jupiter-mock',
        { transactionId: transaction.id }
      );
    }

    // 11. Update status to AWAITING_SIGNATURE via assertTransition
    assertTransition('PENDING', 'AWAITING_SIGNATURE', 'await signature');
    const updatedTransaction = await this.updateTransaction(transaction.id, {
      status: 'AWAITING_SIGNATURE',
    });

    return {
      transactionId: updatedTransaction.id,
      status: 'AWAITING_SIGNATURE',
      serializedTransaction,
      quote: {
        id: quote.id,
        sourceToken: quote.sourceToken,
        sourceAmount: quote.sourceAmount,
        intermediateToken: quote.intermediateToken,
        intermediateAmount: quote.intermediateAmount,
        fiatCurrency: quote.fiatCurrency,
        fiatAmount: quote.fiatAmount,
        rate: quote.rate,
        fee: quote.fee,
        netAmount: quote.netAmount,
      },
      bankAccount: {
        id: bankAccount.id,
        bankName: bankAccount.bankName,
        accountName: bankAccount.accountName,
        accountNumber: maskAccountNumber(bankAccount.accountNumber),
        currency: bankAccount.currency,
        isVerified: bankAccount.isVerified,
      },
      expiresAt: quote.expiresAt.toISOString(),
    };
  }

  /**
   * Endpoint 2: Submit Signed Transaction & Execute Swap + Payout
   */
  static async submit(actor: ActorContext, input: SubmitOffRampInput) {
    if (!input || !input.transactionId || !input.signedTransaction) {
      throw new ValidationError('transactionId and signedTransaction are required');
    }

    // 1. Fetch transaction
    const transaction = await this.findTransaction(input.transactionId);
    if (!transaction) {
      throw new NotFoundError('Transaction');
    }

    // 2. Validate ownership
    if (actor.type === 'consumer' && transaction.userId && transaction.userId !== actor.id) {
      throw new ForbiddenError('Access denied: You do not own this transaction');
    }
    if (actor.type === 'merchant' && transaction.merchantId && transaction.merchantId !== actor.id) {
      throw new ForbiddenError('Access denied: You do not own this transaction');
    }

    // 3. assertTransition to SIGNED
    assertTransition(transaction.status, 'SIGNED', 'submit');

    // 4. Update status to SIGNED
    await this.updateTransaction(transaction.id, { status: 'SIGNED' });

    // 5. Update status to SWAPPING
    assertTransition('SIGNED', 'SWAPPING', 'execute swap');
    await this.updateTransaction(transaction.id, { status: 'SWAPPING' });

    // 6. Submit to Jupiter mock adapter with retry logic
    let swapTxHash: string;
    try {
      const jupiter = getProvider('jupiter');
      const swapResult = await retryWithBackoff(
        () => jupiter.submitSwap(input.signedTransaction),
        { maxAttempts: 3, shouldRetry: (err) => !(err instanceof ValidationError) }
      );
      swapTxHash = swapResult.txHash;
    } catch (swapErr: any) {
      logger.error('[OffRamp] Swap execution failed:', {
        transactionId: transaction.id,
        error: swapErr.message,
      });

      // Transition to FAILED then trigger refund flow
      assertTransition('SWAPPING', 'FAILED', 'fail swap');
      await this.updateTransaction(transaction.id, {
        status: 'FAILED',
        errorCode: 'SWAP_FAILED',
        errorMessage: swapErr.message || 'Swap execution failed',
      });

      // Refund flow
      assertTransition('FAILED', 'REFUNDED', 'refund failed swap');
      await this.updateTransaction(transaction.id, {
        status: 'REFUNDED',
      });

      throw new ProviderError(
        swapErr.message || 'Swap execution failed',
        'jupiter-mock',
        { transactionId: transaction.id }
      );
    }

    // 7. Update status to SWAPPED
    assertTransition('SWAPPING', 'SWAPPED', 'complete swap');
    await this.updateTransaction(transaction.id, {
      status: 'SWAPPED',
      swapTxHash,
    });

    // 8. Queue payout via provider adapter
    assertTransition('SWAPPED', 'PAYOUT_PENDING', 'queue payout');
    await this.updateTransaction(transaction.id, { status: 'PAYOUT_PENDING' });

    // 9. Update status to PAYOUT_PROCESSING
    assertTransition('PAYOUT_PENDING', 'PAYOUT_PROCESSING', 'process payout');
    await this.updateTransaction(transaction.id, { status: 'PAYOUT_PROCESSING' });

    // 10. Execute mock payout
    const bankAccount = await this.findBankAccount(transaction.bankAccountId, actor.id);
    if (!bankAccount) {
      throw new NotFoundError('Bank account');
    }

    let payoutRefId: string;
    try {
      const payoutProvider = getPayoutProvider(transaction.fiatCurrency);
      const payoutResult = await retryWithBackoff(
        () =>
          payoutProvider.executePayout({
            amount: transaction.netAmount,
            currency: transaction.fiatCurrency,
            bankAccountId: bankAccount.id,
            accountNumber: bankAccount.accountNumber,
            bankCode: (bankAccount as any).bankCode || '',
            accountName: bankAccount.accountName,
            reference: transaction.id,
          }),
        { maxAttempts: 3, shouldRetry: (err) => !(err instanceof ValidationError) }
      );
      payoutRefId = payoutResult.payoutRefId;
    } catch (payoutErr: any) {
      logger.error('[OffRamp] Payout execution failed:', {
        transactionId: transaction.id,
        error: payoutErr.message,
      });

      // Transition to FAILED then trigger refund flow
      assertTransition('PAYOUT_PROCESSING', 'FAILED', 'fail payout');
      await this.updateTransaction(transaction.id, {
        status: 'FAILED',
        errorCode: 'PAYOUT_FAILED',
        errorMessage: payoutErr.message || 'Payout execution failed',
      });

      // Refund flow
      assertTransition('FAILED', 'REFUNDED', 'refund failed payout');
      await this.updateTransaction(transaction.id, {
        status: 'REFUNDED',
      });

      throw new ProviderError(
        payoutErr.message || 'Payout execution failed',
        transaction.provider,
        { transactionId: transaction.id }
      );
    }

    // 11. Update status to COMPLETED, set completedAt
    assertTransition('PAYOUT_PROCESSING', 'COMPLETED', 'complete transaction');
    const completedAt = new Date();
    await this.updateTransaction(transaction.id, {
      status: 'COMPLETED',
      payoutRefId,
      completedAt,
    });

    return {
      transactionId: transaction.id,
      status: 'COMPLETED',
      swapTxHash,
      payoutRefId,
      completedAt: completedAt.toISOString(),
    };
  }

  /**
   * Endpoint 3: List Off-Ramp Transactions
   */
  static async list(actor: ActorContext, query: ListTransactionsQuery) {
    let limit = 20;
    if (query.limit !== undefined) {
      const parsed = parseInt(String(query.limit), 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 100) {
        throw new ValidationError('Limit must be an integer between 1 and 100');
      }
      limit = parsed;
    }

    let offset = 0;
    if (query.offset !== undefined) {
      const parsed = parseInt(String(query.offset), 10);
      if (isNaN(parsed) || parsed < 0) {
        throw new ValidationError('Offset must be an integer >= 0');
      }
      offset = parsed;
    }

    let transactions: any[] = [];
    let total = 0;

    try {
      const where: any = actor.type === 'consumer' ? { userId: actor.id } : { merchantId: actor.id };
      if (query.status) {
        where.status = query.status as TransactionStatus;
      }

      const [txs, count] = await Promise.all([
        prisma.offRampTransaction.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: offset,
          take: limit,
        }),
        prisma.offRampTransaction.count({ where }),
      ]);
      transactions = txs;
      total = count;
    } catch (err) {
      logger.warn('[OffRamp] DB list transactions failed, using memory fallback');
      const all = Array.from(memoryTransactions.values()).filter((tx) => {
        const matchesActor =
          actor.type === 'consumer' ? tx.userId === actor.id : tx.merchantId === actor.id;
        const matchesStatus = query.status ? tx.status === query.status : true;
        return matchesActor && matchesStatus;
      });
      total = all.length;
      transactions = all.slice(offset, offset + limit);
    }

    return {
      transactions: transactions.map((tx) => ({
        ...tx,
        createdAt: tx.createdAt instanceof Date ? tx.createdAt.toISOString() : tx.createdAt,
        updatedAt: tx.updatedAt instanceof Date ? tx.updatedAt.toISOString() : tx.updatedAt,
        completedAt: tx.completedAt
          ? tx.completedAt instanceof Date
            ? tx.completedAt.toISOString()
            : tx.completedAt
          : null,
      })),
      total,
      limit,
      offset,
    };
  }

  /**
   * Endpoint 4: Get Off-Ramp Transaction by ID
   */
  static async getById(actor: ActorContext, id: string) {
    const transaction = await this.findTransaction(id);
    if (!transaction) {
      throw new NotFoundError('Transaction');
    }

    if (actor.type === 'consumer' && transaction.userId && transaction.userId !== actor.id) {
      throw new ForbiddenError('Access denied: You do not own this transaction');
    }
    if (actor.type === 'merchant' && transaction.merchantId && transaction.merchantId !== actor.id) {
      throw new ForbiddenError('Access denied: You do not own this transaction');
    }

    let bankAccountInfo = null;
    if (transaction.bankAccountId) {
      const bankAccount = await this.findBankAccount(transaction.bankAccountId, actor.id);
      if (bankAccount) {
        bankAccountInfo = {
          id: bankAccount.id,
          bankName: bankAccount.bankName,
          accountName: bankAccount.accountName,
          accountNumber: maskAccountNumber(bankAccount.accountNumber),
          currency: bankAccount.currency,
          isVerified: bankAccount.isVerified,
        };
      }
    }

    return {
      ...transaction,
      createdAt:
        transaction.createdAt instanceof Date
          ? transaction.createdAt.toISOString()
          : transaction.createdAt,
      updatedAt:
        transaction.updatedAt instanceof Date
          ? transaction.updatedAt.toISOString()
          : transaction.updatedAt,
      completedAt: transaction.completedAt
        ? transaction.completedAt instanceof Date
          ? transaction.completedAt.toISOString()
          : transaction.completedAt
        : null,
      bankAccount: bankAccountInfo,
    };
  }

  /**
   * Endpoint 5: Get Off-Ramp Transaction Status & Progress
   */
  static async getStatus(actor: ActorContext, id: string) {
    const transaction = await this.findTransaction(id);
    if (!transaction) {
      throw new NotFoundError('Transaction');
    }

    if (actor.type === 'consumer' && transaction.userId && transaction.userId !== actor.id) {
      throw new ForbiddenError('Access denied: You do not own this transaction');
    }
    if (actor.type === 'merchant' && transaction.merchantId && transaction.merchantId !== actor.id) {
      throw new ForbiddenError('Access denied: You do not own this transaction');
    }

    const stepMap: Record<
      string,
      { step: number; totalSteps: number; stepLabel: string; isTerminal: boolean }
    > = {
      PENDING: { step: 1, totalSteps: 6, stepLabel: 'Transaction initialized', isTerminal: false },
      AWAITING_SIGNATURE: { step: 2, totalSteps: 6, stepLabel: 'Awaiting signature', isTerminal: false },
      SIGNED: { step: 3, totalSteps: 6, stepLabel: 'Signature received', isTerminal: false },
      SWAPPING: { step: 4, totalSteps: 6, stepLabel: 'Swapping tokens', isTerminal: false },
      SWAPPED: { step: 4, totalSteps: 6, stepLabel: 'Tokens swapped', isTerminal: false },
      PAYOUT_PENDING: { step: 5, totalSteps: 6, stepLabel: 'Queuing fiat payout', isTerminal: false },
      PAYOUT_PROCESSING: { step: 5, totalSteps: 6, stepLabel: 'Processing fiat payout', isTerminal: false },
      COMPLETED: { step: 6, totalSteps: 6, stepLabel: 'Transaction completed', isTerminal: true },
      FAILED: { step: 6, totalSteps: 6, stepLabel: 'Transaction failed', isTerminal: true },
      REFUNDED: { step: 6, totalSteps: 6, stepLabel: 'Transaction refunded', isTerminal: true },
    };

    const info = stepMap[transaction.status] || {
      step: 1,
      totalSteps: 6,
      stepLabel: transaction.status,
      isTerminal: false,
    };

    return {
      id: transaction.id,
      status: transaction.status,
      step: info.step,
      totalSteps: info.totalSteps,
      stepLabel: info.stepLabel,
      isTerminal: info.isTerminal,
    };
  }

  /**
   * Cleanup Job: Clean up expired transactions in AWAITING_SIGNATURE > 10 mins
   */
  static async cleanupExpiredTransactions(): Promise<number> {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    let expiredTxs: any[] = [];
    try {
      expiredTxs = await prisma.offRampTransaction.findMany({
        where: {
          status: 'AWAITING_SIGNATURE',
          createdAt: { lt: tenMinutesAgo },
        },
      });
    } catch (err) {
      logger.warn('[OffRamp] DB find expired transactions failed, checking memory fallback');
      expiredTxs = Array.from(memoryTransactions.values()).filter(
        (tx) => tx.status === 'AWAITING_SIGNATURE' && new Date(tx.createdAt) < tenMinutesAgo
      );
    }

    if (expiredTxs.length === 0) {
      return 0;
    }

    let cleaned = 0;
    for (const tx of expiredTxs) {
      try {
        assertTransition(tx.status, 'FAILED', 'cleanup timeout');
        await this.updateTransaction(tx.id, {
          status: 'FAILED',
          errorCode: 'SIGNATURE_TIMEOUT',
          errorMessage: 'Transaction signature timed out after 10 minutes',
        });

        // Release reserved quote
        if (tx.quoteId) {
          try {
            await prisma.quote.updateMany({
              where: { id: tx.quoteId },
              data: { used: false },
            });
          } catch {}
          await QuoteService.releaseQuote(tx.quoteId);
        }
        cleaned++;
      } catch (err: any) {
        logger.error(`[OffRampCleanup] Failed to clean up transaction ${tx.id}:`, err);
      }
    }

    return cleaned;
  }
}
