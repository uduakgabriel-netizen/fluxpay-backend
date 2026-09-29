import { logger } from '../utils/logger';
/**
 * Email Service — Resend Integration
 *
 * Sends transactional emails to merchants for:
 * - Payment success notifications
 * - Payment failure notifications
 * - Settlement complete notifications
 * - Low SOL balance warnings
 *
 * Uses Resend (https://resend.com) free tier: 3000 emails/month.
 * Emails are sent asynchronously — never blocks the payment flow.
 * Failed emails are retried up to 3 times with exponential backoff.
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'noreply@fluxpay.com';
const SOLSCAN_BASE = 'https://solscan.io/tx/';

// ─── Interfaces ─────────────────────────────────────────────

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

// ─── Core Send Function ─────────────────────────────────────

/**
 * Send an email via Resend API with retry logic.
 * Never throws — logs errors and fails silently.
 */
async function sendEmail(options: SendEmailOptions, retryCount = 0): Promise<boolean> {
  if (!RESEND_API_KEY) {
    logger.warn('[Email] RESEND_API_KEY not configured. Skipping email.');
    return false;
  }

  const maxRetries = 3;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [options.to],
        subject: options.subject,
        html: options.html,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (response.ok) {
      const data = await response.json();
      logger.info(`[Email] ✓ Sent to ${options.to}: "${options.subject}" (id: ${(data as any).id})`);
      return true;
    }

    const errText = await response.text();
    logger.error(`[Email] Resend API error (${response.status}):`, errText);

    // Retry on server errors
    if (response.status >= 500 && retryCount < maxRetries) {
      const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
      logger.info(`[Email] Retrying in ${delay}ms (attempt ${retryCount + 1}/${maxRetries})...`);
      await sleep(delay);
      return sendEmail(options, retryCount + 1);
    }

    return false;
  } catch (error: any) {
    logger.error(`[Email] Error sending email to ${options.to}:`, error.message);

    if (retryCount < maxRetries) {
      const delay = Math.pow(2, retryCount) * 1000;
      logger.info(`[Email] Retrying in ${delay}ms (attempt ${retryCount + 1}/${maxRetries})...`);
      await sleep(delay);
      return sendEmail(options, retryCount + 1);
    }

    return false;
  }
}

// ─── Email Templates ────────────────────────────────────────

const baseStyles = `
  body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #0f0f23; color: #e0e0e0; margin: 0; padding: 0; }
  .container { max-width: 600px; margin: 0 auto; padding: 40px 20px; }
  .card { background: linear-gradient(135deg, #1a1a3e 0%, #16213e 100%); border-radius: 16px; padding: 32px; border: 1px solid rgba(255,255,255,0.1); }
  .logo { font-size: 24px; font-weight: 700; color: #6366f1; margin-bottom: 24px; }
  .title { font-size: 20px; font-weight: 600; color: #ffffff; margin: 0 0 16px 0; }
  .detail { padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; justify-content: space-between; }
  .detail-label { color: #9ca3af; font-size: 14px; }
  .detail-value { color: #ffffff; font-weight: 500; font-size: 14px; }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  .badge-success { background: rgba(16, 185, 129, 0.2); color: #10b981; }
  .badge-error { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
  .badge-warning { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
  .btn { display: inline-block; padding: 12px 24px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; margin-top: 16px; }
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
  <p>FluxPay — Solana Payment Gateway</p>
  <p>This is an automated notification. Please do not reply.</p>
</div>
</div></body></html>`;
}

// ─── Public Email Methods ───────────────────────────────────

export class EmailService {
  /**
   * Payment Success — sent to merchant when swap completes
   */
  static async sendPaymentSuccess(
    merchantEmail: string,
    data: {
      paymentId: string;
      amount: number;
      token: string;
      txHash: string;
      merchantWallet: string;
      customerWallet?: string;
    }
  ): Promise<void> {
    const solscanUrl = `${SOLSCAN_BASE}${data.txHash}`;

    const html = wrapTemplate(`
      <h2 class="title">Payment Received ✅</h2>
      <p style="color: #9ca3af; margin-bottom: 24px;">A payment has been successfully processed and deposited to your wallet.</p>

      <div class="detail">
        <span class="detail-label">Amount</span>
        <span class="detail-value">${data.amount} ${data.token}</span>
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
        <span class="detail-label">Your Wallet</span>
        <span class="detail-value">${data.merchantWallet.slice(0, 8)}...${data.merchantWallet.slice(-4)}</span>
      </div>
      ${data.customerWallet ? `
      <div class="detail">
        <span class="detail-label">Customer Wallet</span>
        <span class="detail-value">${data.customerWallet.slice(0, 8)}...${data.customerWallet.slice(-4)}</span>
      </div>` : ''}
      <div class="detail" style="border-bottom: none;">
        <span class="detail-label">Transaction</span>
        <span class="detail-value"><a href="${solscanUrl}" style="color: #6366f1;">View on Solscan →</a></span>
      </div>
    `);

    await sendEmail({
      to: merchantEmail,
      subject: `✅ Payment Received — ${data.amount} ${data.token}`,
      html,
    });
  }

  /**
   * Payment Failed — sent to merchant when swap fails after all retries
   */
  static async sendPaymentFailed(
    merchantEmail: string,
    data: {
      paymentId: string;
      amount: number;
      token: string;
      reason: string;
    }
  ): Promise<void> {
    const html = wrapTemplate(`
      <h2 class="title">Payment Failed ❌</h2>
      <p style="color: #9ca3af; margin-bottom: 24px;">A payment attempt has failed after multiple retries. The customer's funds were not deducted.</p>

      <div class="detail">
        <span class="detail-label">Amount</span>
        <span class="detail-value">${data.amount} ${data.token}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Payment ID</span>
        <span class="detail-value">${data.paymentId}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Status</span>
        <span class="badge badge-error">FAILED</span>
      </div>
      <div class="detail" style="border-bottom: none;">
        <span class="detail-label">Reason</span>
        <span class="detail-value">${data.reason}</span>
      </div>

      <p style="color: #9ca3af; margin-top: 24px; font-size: 13px;">
        The customer may retry the payment. If this issue persists, please contact support.
      </p>
    `);

    await sendEmail({
      to: merchantEmail,
      subject: `❌ Payment Failed — ${data.paymentId.slice(0, 12)}...`,
      html,
    });
  }

  /**
   * Settlement Complete — sent when settlement transfers are completed
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
      <p style="color: #9ca3af; margin-bottom: 24px;">Your settlement has been processed and funds have been transferred to your wallet.</p>

      <div class="detail">
        <span class="detail-label">Gross Amount</span>
        <span class="detail-value">${data.totalAmount} ${data.token}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Fee Deducted</span>
        <span class="detail-value">${data.fee} ${data.token}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Net Amount</span>
        <span class="detail-value" style="color: #10b981; font-weight: 700;">${data.netAmount} ${data.token}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Payments Included</span>
        <span class="detail-value">${data.paymentCount}</span>
      </div>
      <div class="detail" style="border-bottom: none;">
        <span class="detail-label">Transaction</span>
        <span class="detail-value"><a href="${solscanUrl}" style="color: #6366f1;">View on Solscan →</a></span>
      </div>
    `);

    await sendEmail({
      to: merchantEmail,
      subject: `💰 Settlement Complete — ${data.netAmount} ${data.token}`,
      html,
    });
  }

  /**
   * Low Balance Warning — sent when merchant SOL is below threshold
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
      <p style="color: #9ca3af; margin-bottom: 24px;">Your merchant wallet has a low SOL balance. This may prevent you from receiving new token payments.</p>

      <div class="detail">
        <span class="detail-label">Wallet</span>
        <span class="detail-value">${data.walletAddress.slice(0, 8)}...${data.walletAddress.slice(-4)}</span>
      </div>
      <div class="detail">
        <span class="detail-label">Current Balance</span>
        <span class="badge badge-warning">${data.currentBalance.toFixed(6)} SOL</span>
      </div>
      <div class="detail" style="border-bottom: none;">
        <span class="detail-label">Minimum Required</span>
        <span class="detail-value">${data.requiredBalance} SOL</span>
      </div>

      <p style="color: #9ca3af; margin-top: 24px; font-size: 13px;">
        <strong>Action Required:</strong> Please send at least ${data.requiredBalance} SOL to your merchant wallet to continue receiving token payments. 
        SOL is required to create token accounts for first-time token receipts.
      </p>
    `);

    await sendEmail({
      to: merchantEmail,
      subject: `⚠️ Low SOL Balance — ${data.currentBalance.toFixed(4)} SOL`,
      html,
    });
  }
}

// ─── Utility ────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
