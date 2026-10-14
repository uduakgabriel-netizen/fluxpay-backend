import { Router } from 'express';
import * as assetsController from '../controllers/assets.controller';

const router = Router();

// ─── Public Token Registry Endpoints ─────────────────────────
router.get('/sellable', assetsController.getSellableTokens);
router.get('/sellable/:mint', assetsController.getSellableTokenByMint);

export default router;
