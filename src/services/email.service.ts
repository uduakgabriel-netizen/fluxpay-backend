import { Resend } from 'resend';
import { logger } from '../utils/logger';

/**
 * Email Service — Real Resend Integration (Stage 9)
 *
 * Sends transactional emails for:
 * - Payment received (merchant)
 * - Payout completed (consumer + merchant)
 * - Payout failed (consumer + merchant + admin)
 * - Refund issued (consumer)
 * - Settlement completed (merchant)
 * - Low SOL balance warning (merchant)
 *
 * Emails are asynchronous and non-blocking.
 * Uses FluxPay purple branding (#8b5cf6).
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const SOLSCAN_BASE = 'https://solscan.io/tx/';

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

/**
 * Send an email via Resend SDK with retry logic.
 * Never throws — logs errors and fails gracefully.
 */
async function sendEmail(options: SendEmailOptions, retryCount = 0): Promise<boolean> {
  if (!resend) {
    logger.warn('[Email] RESEND_API_KEY not configured. Skipping email.');
    return false;
  }

  const maxRetries = 3;

  try {
    const { data, error } = await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to: [options.to],
      subject: options.subject,
      html: options.html,
    });

    if (error) {
      logger.warn(`[Email] Resend SDK error: ${error.message}. Attempting direct HTTP fallback...`);
      const httpRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: RESEND_FROM_EMAIL,
          to: [options.to],
          subject: options.subject,
          html: options.html,
        }),
      });

      if (httpRes.ok) {
        const httpData: any = await httpRes.json();
        logger.info(`[Email] ✓ Sent via HTTP to ${options.to}: "${options.subject}" (id: ${httpData?.id})`);
        return true;
      }

      const httpErr = await httpRes.text();
      logger.error(`[Email] Resend direct HTTP error (${httpRes.status}): ${httpErr}`);
      if (httpRes.status >= 500 && retryCount < maxRetries) {
        const delay = Math.pow(2, retryCount) * 1000;
        await sleep(delay);
        return sendEmail(options, retryCount + 1);
      }
      return false;
    }

    logger.info(`[Email] ✓ Sent to ${options.to}: "${options.subject}" (id: ${data?.id})`);
    return true;
  } catch (error: any) {
    logger.warn(`[Email] Error sending email via SDK to ${options.to}: ${error.message}. Attempting direct HTTP fallback...`);
    try {
      const httpRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: RESEND_FROM_EMAIL,
          to: [options.to],
          subject: options.subject,
          html: options.html,
        }),
      });

      if (httpRes.ok) {
        const httpData: any = await httpRes.json();
        logger.info(`[Email] ✓ Sent via HTTP to ${options.to}: "${options.subject}" (id: ${httpData?.id})`);
        return true;
      }
    } catch (httpErr: any) {
      logger.error(`[Email] Direct HTTP fallback failed: ${httpErr.message}`);
    }

    if (retryCount < maxRetries) {
      const delay = Math.pow(2, retryCount) * 1000;
      await sleep(delay);
      return sendEmail(options, retryCount + 1);
    }
    return false;
  }
}

// ─── Email Templates ────────────────────────────────────────

const baseStyles = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b0c16; color: #f3f4f6; margin: 0; padding: 0; }
  .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
  .card { background: #131424; border-radius: 16px; padding: 32px; border: 1px solid rgba(139, 92, 246, 0.2); box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5); }
  .logo { font-size: 26px; font-weight: 800; color: #8b5cf6; margin-bottom: 24px; display: flex; align-items: center; }
  .title { font-size: 20px; font-weight: 700; color: #ffffff; margin: 0 0 16px 0; }
  .subtitle { color: #9ca3af; font-size: 14px; margin-bottom: 24px; line-height: 1.5; }
  .detail { padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; justify-content: space-between; align-items: center; }
  .detail-label { color: #9ca3af; font-size: 14px; }
  .detail-value { color: #ffffff; font-weight: 600; font-size: 14px; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; text-transform: uppercase; }
  .badge-success { background: rgba(16, 185, 129, 0.2); color: #10b981; }
  .badge-error { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
  .badge-warning { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
  .badge-purple { background: rgba(139, 92, 246, 0.2); color: #8b5cf6; }
  .btn { display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #7c3aed, #8b5cf6); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; margin-top: 20px; text-align: center; }
  .footer { text-align: center; margin-top: 32px; font-size: 12px; color: #6b7280; }
`;

function wrapTemplate(content: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>${baseStyles}</style></head>
<body><div class="container"><div class="card">
  <div class="logo">⚡ FluxPay</div>
  ${content}
</div>
<div class="footer">
  <p style="margin: 4px 0;">FluxPay — Solana Non-Custodial Gateway & Off-Ramp</p>
  <p style="margin: 4px 0;">This is an automated notification. Please do not reply.</p>
</div>
</div></body></html>`;
}

// ─── Public Email Methods ───────────────────────────────────

export class EmailService {
  /**
   * Payment received — sent to merchant when payment is completed
   */
  static async sendPaymentSuccess(
    merchantEmail: string,
    data: {
      paymentId: string;
      amount: number | string;
      token: string;
      txHash: string;
      merchantWallet: string;
      customerWallet?: string;
    }
  ): Promise<void> {
    const solscanUrl = `${SOLSCAN_BASE}${data.txHash}`;

    const html = wrapTemplate(`
      <h2 class="title">Payment Received ✅</h2>
      <p class="subtitle">A payment has been successfully confirmed and processed.</p>

      <div class="detail">
        <span class="detail-label">Amount</span>
        <span class="detail-value" style="color: #8b5cf6;">${data.amount} ${data.token}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Payment ID</span>
        <span class="detail-value">${data.paymentId}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Status</span>
        <span class="badge badge-success">COMPLETED</span>
      </div>
      <div class="detail">
        <span class="detail-label">Merchant Wallet</span>
        <span class="detail-value">${data.merchantWallet ? `${data.merchantWallet.slice(0, 8)}...${data.merchantWallet.slice(-4)}` : 'N/A'}</span>
      </div>
      ${
        data.customerWallet
          ? `<div class="detail">
              <span class="detail-label">Customer Wallet</span>
              <span class="detail-value">${data.customerWallet.slice(0, 8)}...${data.customerWallet.slice(-4)}</span>
            </div>`
          : ''
      }
      <div class="detail" style="border-bottom: none;">
        <span class="detail-label">Solana Explorer</span>
        <span class="detail-value"><a href="${solscanUrl}" style="color: #8b5cf6; text-decoration: none;">View on Solscan →</a></span>
      </div>
    `);

    await sendEmail({
      to: merchantEmail,
      subject: `✅ Payment Received — ${data.amount} ${data.token}`,
      html,
    });
  }

  /**
   * Payout completed — sent to consumer and merchant
   */
  static async sendPayoutCompleted(
    recipientEmail: string,
    data: {
      transactionId: string;
      amount: string | number;
      currency: string;
      accountName?: string;
      bankName?: string;
      accountNumber?: string;
    }
  ): Promise<void> {
    const html = wrapTemplate(`
      <h2 class="title">Payout Completed 🎉</h2>
      <p class="subtitle">Your fiat bank payout has been processed successfully.</p>

      <div class="detail">
        <span class="detail-label">Amount</span>
        <span class="detail-value" style="color: #10b981; font-weight: 700;">${data.amount} ${data.currency}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Transaction ID</span>
        <span class="detail-value">${data.transactionId}</span>
      </div>
      ${
        data.bankName
          ? `<div class="detail">
              <span class="detail-label">Bank</span>
              <span class="detail-value">${data.bankName}</span>
            </div>`
          : ''
      }
      ${
        data.accountNumber
          ? `<div class="detail">
              <span class="detail-label">Account Number</span>
              <span class="detail-value">${data.accountNumber}</span>
            </div>`
          : ''
      }
      <div class="detail" style="border-bottom: none;">
        <span class="detail-label">Status</span>
        <span class="badge badge-success">COMPLETED</span>
      </div>
    `);

    await sendEmail({
      to: recipientEmail,
      subject: `🎉 Payout Completed — ${data.amount} ${data.currency}`,
      html,
    });
  }

  /**
   * Payout failed — sent to consumer, merchant, and admin
   */
  static async sendPayoutFailed(
    recipientEmail: string,
    adminEmail: string | undefined,
    data: {
      payoutId: string;
      amount: string | number;
      currency: string;
      reason: string;
    }
  ): Promise<void> {
    const html = wrapTemplate(`
      <h2 class="title">Payout Failed ❌</h2>
      <p class="subtitle">A fiat payout attempt could not be processed. Our system is reviewing this transaction.</p>

      <div class="detail">
        <span class="detail-label">Payout ID</span>
        <span class="detail-value">${data.payoutId}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Amount</span>
        <span class="detail-value">${data.amount} ${data.currency}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Status</span>
        <span class="badge badge-error">FAILED</span>
      </div>
      <div class="detail" style="border-bottom: none;">
        <span class="detail-label">Reason</span>
        <span class="detail-value">${data.reason}</span>
      </div>
    `);

    await sendEmail({
      to: recipientEmail,
      subject: `❌ Payout Failed — ${data.payoutId}`,
      html,
    });

    if (adminEmail) {
      await sendEmail({
        to: adminEmail,
        subject: `[ADMIN ALERT] Payout Failed — ${data.payoutId}`,
        html,
      });
    }
  }

  /**
   * Refund issued — sent to consumer
   */
  static async sendTransactionRefunded(
    consumerEmail: string,
    adminEmail: string | undefined,
    data: {
      transactionId: string;
      amount: string | number;
      token: string;
      reason: string;
    }
  ): Promise<void> {
    const html = wrapTemplate(`
      <h2 class="title">Refund Issued 🔄</h2>
      <p class="subtitle">Your transaction could not be completed and funds have been refunded.</p>

      <div class="detail">
        <span class="detail-label">Transaction ID</span>
        <span class="detail-value">${data.transactionId}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Refunded Amount</span>
        <span class="detail-value" style="color: #f59e0b; font-weight: 700;">${data.amount} ${data.token}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Status</span>
        <span class="badge badge-warning">REFUNDED</span>
      </div>
      <div class="detail" style="border-bottom: none;">
        <span class="detail-label">Reason</span>
        <span class="detail-value">${data.reason}</span>
      </div>
    `);

    await sendEmail({
      to: consumerEmail,
      subject: `🔄 Refund Issued — ${data.transactionId}`,
      html,
    });

    if (adminEmail) {
      await sendEmail({
        to: adminEmail,
        subject: `[ADMIN ALERT] Refund Issued — ${data.transactionId}`,
        html,
      });
    }
  }

  /**
   * Payment failed — sent to merchant
   */
  static async sendPaymentFailed(
    merchantEmail: string,
    data: {
      paymentId: string;
      amount: number | string;
      token: string;
      reason: string;
    }
  ): Promise<void> {
    const html = wrapTemplate(`
      <h2 class="title">Payment Failed ❌</h2>
      <p class="subtitle">A payment attempt was unsuccessful.</p>

      <div class="detail">
        <span class="detail-label">Payment ID</span>
        <span class="detail-value">${data.paymentId}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Amount</span>
        <span class="detail-value">${data.amount} ${data.token}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Status</span>
        <span class="badge badge-error">FAILED</span>
      </div>
      <div class="detail" style="border-bottom: none;">
        <span class="detail-label">Reason</span>
        <span class="detail-value">${data.reason}</span>
      </div>
    `);

    await sendEmail({
      to: merchantEmail,
      subject: `❌ Payment Failed — ${data.paymentId}`,
      html,
    });
  }

  /**
   * Settlement complete — sent to merchant
   */
  static async sendSettlementComplete(
    merchantEmail: string,
    data: {
      totalAmount: number;
      fee: number;
      netAmount: number;
      token: string;
      txHash: string;
      paymentCount: number;
    }
  ): Promise<void> {
    const solscanUrl = `${SOLSCAN_BASE}${data.txHash}`;

    const html = wrapTemplate(`
      <h2 class="title">Settlement Complete 💰</h2>
      <p class="subtitle">Your scheduled settlement has been deposited into your wallet.</p>

      <div class="detail">
        <span class="detail-label">Gross Amount</span>
        <span class="detail-value">${data.totalAmount} ${data.token}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Platform Fee</span>
        <span class="detail-value">${data.fee} ${data.token}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Net Deposited</span>
        <span class="detail-value" style="color: #10b981; font-weight: 700;">${data.netAmount} ${data.token}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Payments Batched</span>
        <span class="detail-value">${data.paymentCount}</span>
      </div>
      <div class="detail" style="border-bottom: none;">
        <span class="detail-label">Solana Explorer</span>
        <span class="detail-value"><a href="${solscanUrl}" style="color: #8b5cf6; text-decoration: none;">View on Solscan →</a></span>
      </div>
    `);

    await sendEmail({
      to: merchantEmail,
      subject: `💰 Settlement Complete — ${data.netAmount} ${data.token}`,
      html,
    });
  }

  /**
   * Low SOL balance warning — sent to merchant
   */
  static async sendLowBalanceWarning(
    merchantEmail: string,
    data: {
      walletAddress: string;
      currentBalance: number;
      requiredBalance: number;
    }
  ): Promise<void> {
    const html = wrapTemplate(`
      <h2 class="title">Low SOL Balance Warning ⚠️</h2>
      <p class="subtitle">Your wallet balance is below the recommended threshold for rent and transaction fees.</p>

      <div class="detail">
        <span class="detail-label">Wallet</span>
        <span class="detail-value">${data.walletAddress ? `${data.walletAddress.slice(0, 8)}...${data.walletAddress.slice(-4)}` : 'N/A'}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Current Balance</span>
        <span class="badge badge-warning">${data.currentBalance.toFixed(6)} SOL</span>
      </div>
      <div class="detail" style="border-bottom: none;">
        <span class="detail-label">Minimum Required</span>
        <span class="detail-value">${data.requiredBalance} SOL</span>
      </div>
    `);

    await sendEmail({
      to: merchantEmail,
      subject: `⚠️ Low SOL Balance — ${data.currentBalance.toFixed(4)} SOL`,
      html,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
