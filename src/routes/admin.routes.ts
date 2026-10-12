import { Router, Request, Response } from 'express';
import { EscrowService } from '../services/escrow.service';
import { runReconciliationJob } from '../jobs/reconciliation.job';
import { getEscrowWalletPublicKey, getGasWalletPublicKey } from '../config/wallets';
import { logger } from '../utils/logger';

const router = Router();

/**
 * GET /api/admin/escrow
 * Returns total USDC in escrow and per-merchant breakdown
 */
router.get('/escrow', async (_req: Request, res: Response) => {
  try {
    const data = await EscrowService.getEscrowTotals();
    const onChainUsdc = await EscrowService.getOnChainEscrowUsdcBalance();

    return res.status(200).json({
      totalEscrowUsdc: data.totalEscrowUsdc,
      onChainEscrowUsdc: onChainUsdc.toFixed(2),
      escrowWalletPublicKey: getEscrowWalletPublicKey().toBase58(),
      gasWalletPublicKey: getGasWalletPublicKey().toBase58(),
      merchants: data.merchants,
    });
  } catch (err: any) {
    logger.error(`[AdminRoutes] GET /api/admin/escrow error: ${err.message}`);
    return res.status(500).json({ error: 'Failed to fetch escrow details' });
  }
});

/**
 * POST /api/admin/reconcile
 * Trigger manual on-demand reconciliation run
 */
router.post('/reconcile', async (_req: Request, res: Response) => {
  try {
    const result = await runReconciliationJob();
    return res.status(200).json({
      message: 'Reconciliation completed',
      result,
    });
  } catch (err: any) {
    logger.error(`[AdminRoutes] POST /api/admin/reconcile error: ${err.message}`);
    return res.status(500).json({ error: 'Failed to run reconciliation' });
  }
});

export default router;
