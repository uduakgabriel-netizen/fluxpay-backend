import { Router } from 'express';
import * as invoiceController from '../controllers/invoice.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/', requireAuth as any, invoiceController.list as any);
router.post('/', requireAuth as any, invoiceController.create as any);
router.patch('/:id/status', requireAuth as any, invoiceController.updateStatus as any);
router.delete('/:id', requireAuth as any, invoiceController.remove as any);

export default router;
