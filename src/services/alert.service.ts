import { logger } from '../utils/logger';
const ALERT_SWAP_FAILURE_THRESHOLD = parseInt(process.env.ALERT_SWAP_FAILURE_THRESHOLD || '5', 10);
const ALERT_WALLET_BALANCE_THRESHOLD = parseFloat(process.env.ALERT_WALLET_BALANCE_THRESHOLD || '0.1');

interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  timestamp: string;
  fields: DiscordEmbedField[];
}

export class AlertService {
  /**
   * Send a POST request to the Discord webhook URL with a Discord embed structure.
   * Handles failures gracefully to never crash the payment flow.
   */
  private static async sendDiscordAlert(embed: DiscordEmbed): Promise<void> {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      try {
        const fs = require('fs');
        const path = require('path');
        const alertLine = `[${embed.timestamp || new Date().toISOString()}] [ALERT] ${embed.title}: ${embed.description} ${JSON.stringify(embed.fields || [])}\n`;
        fs.appendFileSync(path.join(process.cwd(), 'alerts.log'), alertLine);
      } catch (err) {
        // Fallback gracefully
      }
      logger.info(`[AlertService] ${embed.title}: ${embed.description}`);
      return;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });

      if (!response.ok) {
        logger.error(`[AlertService] Discord API error (${response.status}):`, await response.text());
      }
    } catch (error: any) {
      logger.error('[AlertService] Failed to send Discord alert:', error.message);
    }
  }

  // Swap Failure: Payment ID, error message, retry count. (Send after final retry fails)
  public static async alertSwapFailure(paymentId: string, error: string, retryCount: number): Promise<void> {
    await this.sendDiscordAlert({
      title: '❌ Swap Failure',
      description: 'A swap failed after maximum retries.',
      color: 0xff0000, // Red
      timestamp: new Date().toISOString(),
      fields: [
        { name: 'Payment ID', value: paymentId, inline: true },
        { name: 'Retries', value: retryCount.toString(), inline: true },
        { name: 'Error Message', value: error.slice(0, 1024), inline: false },
      ],
    });
  }

  // Swap Success Alert
  public static async alertSwapSuccess(paymentId: string, txHash: string, fromAmount: number, toAmount: number): Promise<void> {
    await this.sendDiscordAlert({
      title: '✅ Swap Success',
      description: 'A non-custodial swap has successfully completed.',
      color: 0x00ff00, // Green
      timestamp: new Date().toISOString(),
      fields: [
        { name: 'Payment ID', value: paymentId, inline: true },
        { name: 'Tx Hash', value: `[View on Solscan](https://solscan.io/tx/${txHash})`, inline: false },
        { name: 'Details', value: `Swapped ${fromAmount} for ${toAmount}`, inline: false }
      ],
    });
  }

  // High Swap Failure Rate
  public static async alertHighSwapFailureRate(failureRatePct: number): Promise<void> {
    if (failureRatePct > ALERT_SWAP_FAILURE_THRESHOLD) {
      await this.sendDiscordAlert({
        title: '⚠️ High Swap Failure Rate',
        description: 'Swap failure rate exceeded threshold!',
        color: 0xffa500, // Orange
        timestamp: new Date().toISOString(),
        fields: [
          { name: 'Failure Rate', value: `${failureRatePct.toFixed(2)}%`, inline: true },
          { name: 'Threshold', value: `${ALERT_SWAP_FAILURE_THRESHOLD}%`, inline: true },
        ],
      });
    }
  }

  // RPC Failover
  public static async alertRpcFailover(failedEndpoint: string, fallbackEndpoint: string, errorMsg: string): Promise<void> {
    await this.sendDiscordAlert({
      title: '🔌 RPC Failover Triggered',
      description: 'Primary RPC failed, switched to fallback.',
      color: 0xffa500, // Orange
      timestamp: new Date().toISOString(),
      fields: [
        { name: 'Failed Endpoint', value: failedEndpoint.slice(0, 60) + '...', inline: false },
        { name: 'Fallback Endpoint', value: fallbackEndpoint.slice(0, 60) + '...', inline: false },
        { name: 'Error', value: (errorMsg || 'Unknown').slice(0, 1024), inline: false },
      ],
    });
  }

  // Webhook Delivery Failure
  public static async alertWebhookFailure(merchantId: string, event: string, url: string, retries: number): Promise<void> {
    await this.sendDiscordAlert({
      title: '💀 Webhook Delivery Failure',
      description: 'A merchant webhook failed after all retries.',
      color: 0xff0000, // Red
      timestamp: new Date().toISOString(),
      fields: [
        { name: 'Merchant ID', value: merchantId, inline: true },
        { name: 'Event', value: event, inline: true },
        { name: 'Target URL', value: url, inline: false },
        { name: 'Retries Used', value: retries.toString(), inline: true },
      ],
    });
  }

  // Low FluxPay Wallet Balance
  public static async alertLowWalletBalance(address: string, balance: number): Promise<void> {
    if (balance < ALERT_WALLET_BALANCE_THRESHOLD) {
      await this.sendDiscordAlert({
        title: '📉 Low FluxPay Wallet Balance',
        description: `FluxPay gas wallet balance is below ${ALERT_WALLET_BALANCE_THRESHOLD} SOL.`,
        color: 0xff0000, // Red
        timestamp: new Date().toISOString(),
        fields: [
          { name: 'Wallet Address', value: address, inline: false },
          { name: 'Current Balance (SOL)', value: balance.toFixed(4), inline: true },
          { name: 'Threshold (SOL)', value: ALERT_WALLET_BALANCE_THRESHOLD.toString(), inline: true },
        ],
      });
    }
  }

  // Low Merchant SOL Balance (NEW — non-custodial)
  public static async alertLowMerchantSol(
    merchantWallet: string,
    balance: number,
    paymentId?: string,
    businessName?: string
  ): Promise<void> {
    await this.sendDiscordAlert({
      title: '⚠️ Low Merchant SOL Balance',
      description: 'A merchant wallet has insufficient SOL for ATA rent. New token receipts may fail.',
      color: 0xffa500, // Orange
      timestamp: new Date().toISOString(),
      fields: [
        ...(businessName ? [{ name: 'Merchant', value: businessName, inline: true }] : []),
        { name: 'Wallet', value: merchantWallet, inline: false },
        { name: 'Balance (SOL)', value: balance.toFixed(6), inline: true },
        { name: 'Required', value: '≥ 0.005 SOL', inline: true },
        ...(paymentId ? [{ name: 'Affected Payment', value: paymentId, inline: false }] : []),
      ],
    });
  }

  // Server Startup Alert (NEW)
  public static async alertServerStartup(): Promise<void> {
    const network = process.env.SOLANA_NETWORK || 'devnet';
    const port = process.env.PORT || '5000';

    await this.sendDiscordAlert({
      title: '🚀 FluxPay Server Started',
      description: 'The FluxPay backend server has started successfully.',
      color: 0x00ff00, // Green
      timestamp: new Date().toISOString(),
      fields: [
        { name: 'Network', value: network, inline: true },
        { name: 'Port', value: port, inline: true },
        { name: 'Mode', value: process.env.NODE_ENV || 'development', inline: true },
        { name: 'Architecture', value: 'Non-Custodial', inline: true },
      ],
    });
  }

  // Server Shutdown Alert (NEW)
  public static async alertServerShutdown(signal: string): Promise<void> {
    await this.sendDiscordAlert({
      title: '🛑 FluxPay Server Shutting Down',
      description: `Server is shutting down gracefully (signal: ${signal}).`,
      color: 0xffa500, // Orange
      timestamp: new Date().toISOString(),
      fields: [
        { name: 'Signal', value: signal, inline: true },
        { name: 'Time', value: new Date().toLocaleString(), inline: true },
      ],
    });
  }

  // ─── Stage 7 Admin Alerts ────────────────────────────────────

  /** Webhook signature invalid: Warning: "Invalid webhook signature from [provider]" */
  public static async alertInvalidSignature(provider: string): Promise<void> {
    await this.sendDiscordAlert({
      title: '⚠️ Invalid Webhook Signature',
      description: `Invalid webhook signature from ${provider}`,
      color: 0xffa500, // Warning Orange
      timestamp: new Date().toISOString(),
      fields: [
        { name: 'Provider', value: provider, inline: true },
        { name: 'Severity', value: 'Warning', inline: true },
      ],
    });
  }

  /** 5+ webhook failures in 10 min: Warning: "High webhook failure rate" */
  public static async alertHighWebhookFailureRate(failuresCount = 5, windowMinutes = 10): Promise<void> {
    await this.sendDiscordAlert({
      title: '⚠️ High Webhook Failure Rate',
      description: 'High webhook failure rate',
      color: 0xffa500, // Warning Orange
      timestamp: new Date().toISOString(),
      fields: [
        { name: 'Failures', value: `${failuresCount} failures`, inline: true },
        { name: 'Window', value: `${windowMinutes} minutes`, inline: true },
        { name: 'Severity', value: 'Warning', inline: true },
      ],
    });
  }

  /** Settlement failed 3 times: Critical: "Settlement [id] permanently failed" */
  public static async alertSettlementPermanentlyFailed(settlementId: string, attempts = 3): Promise<void> {
    await this.sendDiscordAlert({
      title: '🚨 Permanent Settlement Failure',
      description: `Settlement ${settlementId} permanently failed`,
      color: 0xff0000, // Critical Red
      timestamp: new Date().toISOString(),
      fields: [
        { name: 'Settlement ID', value: settlementId, inline: true },
        { name: 'Attempts', value: attempts.toString(), inline: true },
        { name: 'Severity', value: 'Critical', inline: true },
      ],
    });
  }

  /** Transaction stuck > 30 min: Critical: "Transaction [id] stuck in [status]" */
  public static async alertTransactionStuck(transactionId: string, status: string, durationMinutes = 30): Promise<void> {
    await this.sendDiscordAlert({
      title: '🚨 Stuck Transaction Alert',
      description: `Transaction ${transactionId} stuck in ${status}`,
      color: 0xff0000, // Critical Red
      timestamp: new Date().toISOString(),
      fields: [
        { name: 'Transaction ID', value: transactionId, inline: true },
        { name: 'Status', value: status, inline: true },
        { name: 'Duration', value: `>${durationMinutes} minutes`, inline: true },
        { name: 'Severity', value: 'Critical', inline: true },
      ],
    });
  }

  /** Wallet balance < 0.1 SOL: Critical: "Low gas wallet balance: [balance] SOL" */
  public static async alertLowGasWalletBalance(balance: number): Promise<void> {
    await this.sendDiscordAlert({
      title: '🚨 Low Gas Wallet Balance',
      description: `Low gas wallet balance: ${balance} SOL`,
      color: 0xff0000, // Critical Red
      timestamp: new Date().toISOString(),
      fields: [
        { name: 'Balance', value: `${balance} SOL`, inline: true },
        { name: 'Threshold', value: '0.1 SOL', inline: true },
        { name: 'Severity', value: 'Critical', inline: true },
      ],
    });
  }

  /** Provider API error rate > 10%: Warning: "Provider [name] error rate elevated" */
  public static async alertProviderElevatedErrorRate(providerName: string, errorRatePct: number): Promise<void> {
    await this.sendDiscordAlert({
      title: '⚠️ Provider Error Rate Elevated',
      description: `Provider ${providerName} error rate elevated`,
      color: 0xffa500, // Warning Orange
      timestamp: new Date().toISOString(),
      fields: [
        { name: 'Provider', value: providerName, inline: true },
        { name: 'Error Rate', value: `${errorRatePct.toFixed(1)}%`, inline: true },
        { name: 'Severity', value: 'Warning', inline: true },
      ],
    });
  }
}
