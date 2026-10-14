import { logger } from '../utils/logger';
/**
 * Solana Configuration
 *
 * Production-ready Solana RPC configuration with:
 * - Multi-RPC failover (primary → secondary → fallback)
 * - Priority fee calculation
 * - Connection pooling via @solana/web3.js
 */

import { Connection, Commitment } from '@solana/web3.js';
import { AlertService } from '../services/alert.service';

// ─── RPC Endpoints ──────────────────────────────────────────

const SOLANA_NETWORK = process.env.SOLANA_NETWORK || 'devnet';

/**
 * RPC endpoint priority list.
 * Falls back through the list if the primary endpoint fails.
 */
function getRpcEndpoints(): string[] {
  if (SOLANA_NETWORK === 'mainnet' || SOLANA_NETWORK === 'mainnet-beta') {
    return [
      process.env.SOLANA_RPC_PRIMARY || 'https://api.mainnet-beta.solana.com',
      process.env.SOLANA_RPC_SECONDARY || 'https://api.mainnet-beta.solana.com',
      process.env.SOLANA_RPC_FALLBACK || 'https://api.mainnet-beta.solana.com',
    ].filter(Boolean);
  }

  return [
    process.env.SOLANA_RPC_DEVNET || 'https://api.devnet.solana.com',
  ];
}

// ─── Connection Pool ────────────────────────────────────────

let _connections: Connection[] | null = null;

/**
 * Get the ordered list of Solana connections (primary first).
 * Connections are lazily created and cached.
 */
function getConnections(): Connection[] {
  if (!_connections) {
    const endpoints = getRpcEndpoints();
    _connections = endpoints.map(
      (endpoint) =>
        new Connection(endpoint, {
          commitment: 'confirmed' as Commitment,
          confirmTransactionInitialTimeout: 60_000,
        })
    );
    logger.info(
      `[Solana] Initialized ${_connections.length} RPC connection(s) on ${SOLANA_NETWORK}`
    );
  }
  return _connections;
}

/**
 * Get the primary Solana connection.
 */
export function getConnection(): Connection {
  return getConnections()[0];
}

/**
 * Execute an RPC call with automatic failover.
 * Tries each connection in order until one succeeds.
 *
 * @param fn - Async function that takes a Connection and returns a result
 * @returns The result from the first successful connection
 */
export async function withFailover<T>(
  fn: (connection: Connection) => Promise<T>
): Promise<T> {
  const connections = getConnections();
  let lastError: Error | null = null;

  for (let i = 0; i < connections.length; i++) {
    try {
      return await fn(connections[i]);
    } catch (error: any) {
      lastError = error;
      logger.warn(
        `[Solana] RPC endpoint ${i + 1}/${connections.length} failed: ${error.message}`
      );
      if (i + 1 < connections.length) {
        AlertService.alertRpcFailover(
          connections[i].rpcEndpoint,
          connections[i + 1].rpcEndpoint,
          error.message
        ).catch(logger.error);
      }
    }
  }

  throw lastError || new Error('All RPC endpoints failed');
}

// ─── Priority Fees ──────────────────────────────────────────

/**
 * Get the recommended priority fee (in micro-lamports per compute unit)
 * based on recent network conditions.
 *
 * Returns a reasonable default if the RPC call fails.
 */
export async function getRecommendedPriorityFee(): Promise<number> {
  try {
    const connection = getConnection();
    const fees = await connection.getRecentPrioritizationFees();

    if (!fees || fees.length === 0) {
      return 1_000; // Default: 1000 micro-lamports per CU
    }

    // Use the median of recent fees for a balanced approach
    const sortedFees = fees
      .map((f) => f.prioritizationFee)
      .filter((f) => f > 0)
      .sort((a, b) => a - b);

    if (sortedFees.length === 0) {
      return 1_000;
    }

    const median = sortedFees[Math.floor(sortedFees.length / 2)];

    // Cap at 100,000 micro-lamports to avoid overpaying
    return Math.min(median, 100_000);
  } catch (error) {
    logger.warn('[Solana] Failed to get priority fees, using default:', error);
    return 1_000;
  }
}

// ─── Network Info ───────────────────────────────────────────

/**
 * Get the current Solana network name
 */
export function getNetwork(): string {
  return SOLANA_NETWORK;
}

/**
 * Check if running on mainnet
 */
export function isMainnet(): boolean {
  return SOLANA_NETWORK === 'mainnet' || SOLANA_NETWORK === 'mainnet-beta';
}

/**
 * Get the Solscan base URL for the current network
 */
export function getSolscanUrl(signature: string): string {
  const base = 'https://solscan.io/tx/';
  const suffix = isMainnet() ? '' : '?cluster=devnet';
  return `${base}${signature}${suffix}`;
}
