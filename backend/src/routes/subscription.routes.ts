import { Router } from 'express';
import * as subscriptionController from '../controllers/subscription.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/', requireAuth as any, subscriptionController.list as any);
router.post('/', requireAuth as any, subscriptionController.create as any);
router.patch('/:id/:action', requireAuth as any, subscriptionController.updateStatus as any);

export default router;
