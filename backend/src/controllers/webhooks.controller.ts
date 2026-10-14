import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
import { assertTransition } from '../utils/transactionStateMachine';
import { memoryTransactions, OfframpExecutionService } from '../services/offrampExecution.service';
import { memorySettlements, SettlementService } from '../services/settlement.service';
import { AlertService } from '../services/alert.service';
import { EmailService } from '../services/email.service';
import { memoryWebhookLogs } from '../middleware/verifyWebhookSignature';
import { MonnifyAdapter } from '../providers/monnify/monnify.adapter';
import { refundEscrowToUser } from '../services/routing.service';

const prisma = new PrismaClient();

// In-memory set for idempotency check on duplicate transactions (txHash)
const processedTxHashes = new Set<string>();

/**
 * Helper to log webhook event in DB or in-memory
 */
async function recordWebhookEvent(data: {
  merchantId?: string | null;
  event: string;
  url: string;
  payload: any;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  statusCode?: number;
  error?: string;
}) {
  try {
    await prisma.webhookLog.create({
      data: {
        merchantId: data.merchantId || null,
        event: data.event,
        url: data.url,
        payload: data.payload,
        status: data.status,
        statusCode: data.statusCode || (data.status === 'SUCCESS' ? 200 : 500),
        error: data.error,
        createdAt: new Date(),
      } as any,
    });
  } catch {
    memoryWebhookLogs.push({
      id: `mem_log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ...data,
      createdAt: new Date(),
    });
  }
}

/**
 * Endpoint 1: POST /api/webhooks/helius
 * Purpose: Receive payment detection from Helius.
 */
export async function handleHeliusWebhook(req: Request, res: Response): Promise<void> {
  const payload = req.body;
  const transactions: any[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.transactions)
    ? payload.transactions
    : payload
    ? [payload]
    : [];

  logger.info(`[Helius Webhook] Received webhook with ${transactions.length} item(s)`);

  for (const tx of transactions) {
    const txHash = tx.signature || tx.txHash || tx.id;

    // Idempotency check: duplicate transaction
    if (txHash && processedTxHashes.has(txHash)) {
      logger.info(`[Helius Webhook] Duplicate tx ${txHash} already processed, skipping`);
      continue;
    }

    if (txHash) {
      processedTxHashes.add(txHash);
    }

    // Extract payment reference (order ID / memo / description)
    const orderId =
      tx.reference ||
      tx.orderId ||
      tx.paymentId ||
      tx.description ||
      (tx.accountData && tx.accountData[0]?.account) ||
      txHash;

    try {
      // Find matching payment in DB
      let payment: any = null;
      try {
        payment = await prisma.payment.findFirst({
          where: {
            OR: [
              { id: orderId },
              { txHash: txHash },
              ...(orderId ? [{ metadata: { path: ['orderId'], equals: orderId } }] : []),
            ],
          },
        });
      } catch (dbErr: any) {
        logger.warn(`[Helius Webhook] DB lookup failed: ${dbErr.message}`);
      }

      if (!payment) {
        logger.warn(`[Helius Webhook] Payment not found for reference ${orderId || txHash}, continuing`);
        await recordWebhookEvent({
          event: 'payment.not_found',
          url: req.originalUrl,
          payload: tx,
          status: 'SUCCESS',
          statusCode: 200,
        });
        continue;
      }

      // Update payment status to DETECTED
      try {
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: 'CONFIRMED' as any,
            txHash: txHash || payment.txHash,
          },
        });
      } catch (updateErr: any) {
        logger.warn(`[Helius Webhook] DB update failed: ${updateErr.message}`);
      }

      // Trigger settlement logic (crypto or fiat branch)
      let merchant: any = null;
      try {
        merchant = await prisma.merchant.findUnique({
          where: { id: payment.merchantId },
        });
      } catch {
        // fallback
      }

      if (merchant?.settlementType === 'FIAT') {
        logger.info(`[Helius Webhook] Payment ${payment.id} queued for fiat settlement cron`);
        // Recorded for daily settlement job
      } else {
        logger.info(`[Helius Webhook] Payment ${payment.id} processed under CRYPTO settlement`);
      }

      await recordWebhookEvent({
        merchantId: payment.merchantId,
        event: 'payment.detected',
        url: req.originalUrl,
        payload: tx,
        status: 'SUCCESS',
        statusCode: 200,
      });
    } catch (err: any) {
      logger.error(`[Helius Webhook] Error processing tx: ${err.message}`);
      await recordWebhookEvent({
        event: 'payment.error',
        url: req.originalUrl,
        payload: tx,
        status: 'FAILED',
        error: err.message,
      });
      // DB error -> log, return 200 (Helius will retry)
    }
  }

  // Return 200 { received: true } — always, even on partial failures
  res.status(200).json({ received: true });
}

/**
 * Endpoint 2 & 3: Process Provider Payout Webhook (NGN / USD / EUR)
 */
async function processProviderPayoutWebhook(
  providerName: 'ngn' | 'usdeur',
  req: Request,
  res: Response
): Promise<void> {
  const { event, providerRefId, status, amount, currency, settledAt } = req.body || {};

  logger.info(`[${providerName.toUpperCase()} Webhook] Event: ${event}, Ref: ${providerRefId}, Status: ${status}`);

  if (!providerRefId) {
    logger.warn(`[${providerName.toUpperCase()} Webhook] Missing providerRefId`);
    await recordWebhookEvent({
      event: event || `payout.${providerName}`,
      url: req.originalUrl,
      payload: req.body,
      status: 'FAILED',
      statusCode: 400,
      error: 'Missing providerRefId',
    });
    res.status(200).json({ received: true });
    return;
  }

  try {
    // 1. Check OffRampTransaction
    let offrampTx: any = null;
    try {
      offrampTx = await prisma.offRampTransaction.findFirst({
        where: {
          OR: [{ payoutRefId: providerRefId }, { id: providerRefId }],
        },
      });
    } catch {
      // Memory fallback
    }

    if (!offrampTx) {
      for (const tx of memoryTransactions.values()) {
        if (tx.payoutRefId === providerRefId || tx.id === providerRefId) {
          offrampTx = tx;
          break;
        }
      }
    }

    if (offrampTx) {
      let targetStatus: any = offrampTx.status;
      const updates: any = {};

      if (event === 'payout.processing' || status === 'processing') {
        targetStatus = 'PAYOUT_PROCESSING';
        assertTransition(offrampTx.status, targetStatus, 'provider payout processing');
        updates.status = targetStatus;
      } else if (event === 'payout.completed' || status === 'completed') {
        targetStatus = 'COMPLETED';
        assertTransition(offrampTx.status, targetStatus, 'provider payout completed');
        updates.status = targetStatus;
        updates.completedAt = new Date(settledAt || Date.now());
      } else if (event === 'payout.failed' || status === 'failed') {
        targetStatus = 'FAILED';
        assertTransition(offrampTx.status, targetStatus, 'provider payout failed');
        updates.status = targetStatus;
        updates.errorMessage = req.body.error || 'Provider reported payout failure';
        updates.errorCode = 'PAYOUT_FAILED';

        // Trigger email alert
        EmailService.sendPayoutFailed(
          'merchant@fluxpay.io',
          process.env.ADMIN_EMAIL || 'admin@fluxpay.io',
          {
            payoutId: providerRefId,
            amount: amount || offrampTx.fiatAmount,
            currency: currency || offrampTx.fiatCurrency,
            reason: updates.errorMessage,
          }
        ).catch(() => {});
      }

      // Update in DB or memory
      try {
        await prisma.offRampTransaction.update({
          where: { id: offrampTx.id },
          data: updates,
        });
      } catch {
        Object.assign(offrampTx, updates, { updatedAt: new Date() });
      }

      await recordWebhookEvent({
        merchantId: offrampTx.merchantId,
        event: event || `payout.${status}`,
        url: req.originalUrl,
        payload: req.body,
        status: 'SUCCESS',
        statusCode: 200,
      });

      res.status(200).json({ received: true });
      return;
    }

    // 2. Check Settlement
    let settlement: any = null;
    try {
      settlement = await prisma.settlement.findFirst({
        where: {
          OR: [
            { id: providerRefId },
            { providerRefId: providerRefId },
            { txHash: providerRefId },
          ],
        },
      });
    } catch {
      // Memory fallback
    }

    if (!settlement) {
      for (const s of memorySettlements.values()) {
        if (
          s.id === providerRefId ||
          s.providerRefId === providerRefId ||
          s.payoutRefId === providerRefId ||
          s.reference === providerRefId
        ) {
          settlement = s;
          break;
        }
      }
    }

    if (settlement) {
      let targetStatus: any = settlement.status;
      const sUpdates: any = {};

      if (event === 'payout.processing' || status === 'processing') {
        targetStatus = 'PROCESSING';
        sUpdates.status = targetStatus;
      } else if (event === 'payout.completed' || status === 'completed') {
        targetStatus = 'COMPLETED';
        sUpdates.status = targetStatus;
        sUpdates.settledAt = new Date(settledAt || Date.now());

        // Send email alert for completed settlement
        let merchantEmail = 'merchant@fluxpay.io';
        try {
          const m = await prisma.merchant.findUnique({ where: { id: settlement.merchantId } });
          if (m?.email) merchantEmail = m.email;
        } catch {}

        EmailService.sendSettlementComplete(merchantEmail, {
          totalAmount: parseFloat(settlement.fiatAmount || settlement.amount || '0'),
          fee: parseFloat(settlement.fee || '0'),
          netAmount: parseFloat(settlement.netAmount || settlement.amount || '0'),
          token: settlement.fiatCurrency || settlement.token || 'NGN',
          txHash: settlement.txHash || providerRefId,
          paymentCount: 1,
        }).catch(() => {});
      } else if (event === 'payout.failed' || status === 'failed') {
        targetStatus = 'FAILED';
        sUpdates.status = targetStatus;
        sUpdates.errorMessage = req.body.error || 'Payout failed';
        const retryCount = (settlement.retryCount || 0) + 1;
        sUpdates.retryCount = retryCount;

        if (retryCount >= 3) {
          AlertService.alertSettlementPermanentlyFailed(settlement.id, retryCount).catch(() => {});
        }
      }

      Object.assign(settlement, sUpdates, { updatedAt: new Date() });
      try {
        await prisma.settlement.update({
          where: { id: settlement.id },
          data: sUpdates,
        });
      } catch {
        // DB not available
      }

      await recordWebhookEvent({
        merchantId: settlement.merchantId,
        event: event || `payout.${status}`,
        url: req.originalUrl,
        payload: req.body,
        status: 'SUCCESS',
        statusCode: 200,
      });

      res.status(200).json({ received: true });
      return;
    }

    // Neither transaction nor settlement found
    logger.warn(`[${providerName.toUpperCase()} Webhook] No matching OffRampTransaction or Settlement for ref ${providerRefId}`);
    await recordWebhookEvent({
      event: event || `payout.${status}`,
      url: req.originalUrl,
      payload: req.body,
      status: 'SUCCESS',
      statusCode: 200,
    });

    res.status(200).json({ received: true });
  } catch (err: any) {
    logger.error(`[${providerName.toUpperCase()} Webhook] Processing error: ${err.message}`);
    await recordWebhookEvent({
      event: event || `payout.${providerName}`,
      url: req.originalUrl,
      payload: req.body,
      status: 'FAILED',
      error: err.message,
    });
    // Return 200 even on internal processing error so provider doesn't infinitely loop
    res.status(200).json({ received: true });
  }
}

/**
 * Endpoint 2: POST /api/webhooks/ngn
 */
export async function handleNgnWebhook(req: Request, res: Response): Promise<void> {
  await processProviderPayoutWebhook('ngn', req, res);
}

/**
 * Endpoint 3: POST /api/webhooks/usdeur
 */
export async function handleUsdEurWebhook(req: Request, res: Response): Promise<void> {
  await processProviderPayoutWebhook('usdeur', req, res);
}

/**
 * Endpoint 4: POST /api/webhooks/solana
 * Helius / QuickNode webhook monitoring Escrow Wallet (BVEdrd5KjqqPemaZk13vxxoKZ82imHLkpm5fqCiyb64E)
 */
export async function handleSolanaWebhook(req: Request, res: Response): Promise<void> {
  const payload = req.body;
  const items: any[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.transactions)
    ? payload.transactions
    : payload
    ? [payload]
    : [];

  logger.info(`[Solana Webhook] Received ${items.length} transaction event(s)`);

  for (const item of items) {
    const txHash = item.signature || item.txHash || item.id;
    if (txHash && processedTxHashes.has(txHash)) {
      continue;
    }
    if (txHash) processedTxHashes.add(txHash);

    try {
      // Find matching OffRampTransaction
      let offrampTx: any = null;
      if (txHash) {
        try {
          offrampTx = await prisma.offRampTransaction.findFirst({
            where: {
              OR: [
                { swapTxHash: txHash },
                { id: txHash },
              ],
            },
          });
        } catch {}
      }

      // If not found by exact signature, look for any transaction recently broadcasting or awaiting signature
      if (!offrampTx) {
        try {
          offrampTx = await prisma.offRampTransaction.findFirst({
            where: {
              status: { in: ['BROADCASTING', 'SWAPPING', 'AWAITING_SIGNATURE'] },
            },
            orderBy: { createdAt: 'desc' },
          });
        } catch {}
      }

      // Check memory fallback
      if (!offrampTx) {
        for (const tx of memoryTransactions.values()) {
          if (tx.swapTxHash === txHash || ['BROADCASTING', 'SWAPPING', 'AWAITING_SIGNATURE'].includes(tx.status)) {
            offrampTx = tx;
            break;
          }
        }
      }

      if (offrampTx) {
        logger.info(`[Solana Webhook] Matched offramp transaction ${offrampTx.id}. Setting status to CRYPTO_RECEIVED.`);

        // 1. Transition to CRYPTO_RECEIVED
        try {
          assertTransition(offrampTx.status, 'CRYPTO_RECEIVED', 'solana escrow deposit');
        } catch {}

        await OfframpExecutionService.updateTransaction(offrampTx.id, {
          status: 'CRYPTO_RECEIVED',
          swapTxHash: txHash || offrampTx.swapTxHash,
        });

        // 2. Immediately trigger Fiat Payout flow (Monnify)
        if (offrampTx.fiatCurrency === 'NGN' && offrampTx.bankAccountId) {
          const bankAccount = await OfframpExecutionService.findBankAccount(
            offrampTx.bankAccountId,
            offrampTx.userId || offrampTx.merchantId || ''
          );

          if (bankAccount) {
            try {
              assertTransition('CRYPTO_RECEIVED', 'FIAT_PROCESSING', 'trigger fiat disbursement');
            } catch {}

            await OfframpExecutionService.updateTransaction(offrampTx.id, {
              status: 'FIAT_PROCESSING',
            });

            logger.info(`[Solana Webhook] Immediately triggering Monnify payout for ${offrampTx.id} (₦${offrampTx.netAmount})`);

            const monnifyRes = await MonnifyAdapter.initiateDisbursement({
              amount: offrampTx.netAmount,
              reference: offrampTx.id, // Idempotency key
              bankCode: bankAccount.bankCode || '',
              accountNumber: bankAccount.accountNumber,
              accountName: bankAccount.accountName,
              currency: 'NGN',
            });

            if (monnifyRes.status === 'COMPLETED') {
              try {
                assertTransition('FIAT_PROCESSING', 'COMPLETED', 'monnify immediate success');
              } catch {}
              await OfframpExecutionService.updateTransaction(offrampTx.id, {
                status: 'COMPLETED',
                payoutRefId: monnifyRes.payoutRefId,
                completedAt: new Date(),
              });
            }
          }
        }

        await recordWebhookEvent({
          merchantId: offrampTx.merchantId,
          event: 'solana.crypto_received',
          url: req.originalUrl,
          payload: item,
          status: 'SUCCESS',
          statusCode: 200,
        });
      }
    } catch (err: any) {
      logger.error(`[Solana Webhook] Error processing item: ${err.message}`);
    }
  }

  res.status(200).json({ received: true });
}

/**
 * Endpoint 5: POST /api/webhooks/monnify
 * Monnify disbursement webhook listener
 */
export async function handleMonnifyWebhook(req: Request, res: Response): Promise<void> {
  const payload = req.body || {};
  const eventType = payload.eventType || payload.event;
  const eventData = payload.eventData || payload.data || payload;

  const reference =
    eventData.reference ||
    eventData.transactionReference ||
    eventData.paymentReference ||
    payload.reference;

  logger.info(`[Monnify Webhook] Event: ${eventType}, Reference: ${reference}`);

  if (!reference) {
    logger.warn('[Monnify Webhook] Received webhook without reference');
    res.status(200).json({ received: true });
    return;
  }

  try {
    // 1. Look up OffRampTransaction
    let offrampTx = await OfframpExecutionService.findTransaction(reference);
    if (!offrampTx) {
      try {
        offrampTx = await prisma.offRampTransaction.findFirst({
          where: {
            OR: [
              { id: reference },
              { payoutRefId: reference },
            ],
          },
        });
      } catch {}
    }

    if (offrampTx) {
      if (
        eventType === 'SUCCESSFUL_DISBURSEMENT' ||
        eventData.status === 'SUCCESS' ||
        eventData.status === 'PAID'
      ) {
        logger.info(`[Monnify Webhook] Disbursement successful for transaction ${offrampTx.id}`);
        try {
          assertTransition(offrampTx.status, 'COMPLETED', 'monnify webhook complete');
        } catch {}

        await OfframpExecutionService.updateTransaction(offrampTx.id, {
          status: 'COMPLETED',
          payoutRefId: eventData.transactionReference || reference,
          completedAt: new Date(),
        });

        await recordWebhookEvent({
          merchantId: offrampTx.merchantId,
          event: 'monnify.disbursement_success',
          url: req.originalUrl,
          payload,
          status: 'SUCCESS',
          statusCode: 200,
        });
      } else if (
        eventType === 'FAILED_DISBURSEMENT' ||
        eventData.status === 'FAILED'
      ) {
        logger.warn(`[Monnify Webhook] Disbursement failed for transaction ${offrampTx.id}`);
        try {
          assertTransition(offrampTx.status, 'FAILED', 'monnify webhook failed');
        } catch {}

        await OfframpExecutionService.updateTransaction(offrampTx.id, {
          status: 'FAILED',
          errorCode: 'MONNIFY_DISBURSEMENT_FAILED',
          errorMessage: eventData.message || 'Monnify reported disbursement failure',
        });

        // Trigger Escrow refund back to user wallet
        try {
          assertTransition('FAILED', 'REFUNDED', 'refund failed disbursement');
        } catch {}

        await OfframpExecutionService.updateTransaction(offrampTx.id, {
          status: 'REFUNDED',
        });

        const userWallet = (offrampTx as any).userPublicKey || offrampTx.userId || offrampTx.merchantId;
        if (userWallet && userWallet.length >= 32) {
          refundEscrowToUser({
            userWalletAddress: userWallet,
            usdcAmount: offrampTx.intermediateAmount || offrampTx.sourceAmount,
          }).catch((err) => logger.error('[Monnify Webhook] Refund to user failed:', err));
        }

        await recordWebhookEvent({
          merchantId: offrampTx.merchantId,
          event: 'monnify.disbursement_failed',
          url: req.originalUrl,
          payload,
          status: 'FAILED',
          statusCode: 200,
          error: eventData.message,
        });
      }

      res.status(200).json({ received: true });
      return;
    }

    // 2. Check Settlement
    await processProviderPayoutWebhook('ngn', req, res);
  } catch (err: any) {
    logger.error(`[Monnify Webhook] Error: ${err.message}`);
    res.status(200).json({ received: true });
  }
}

