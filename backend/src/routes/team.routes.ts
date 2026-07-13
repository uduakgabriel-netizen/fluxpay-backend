import { Router } from 'express';
import * as teamController from '../controllers/team.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/', requireAuth as any, teamController.list as any);
router.post('/invite', requireAuth as any, teamController.invite as any);
router.delete('/:id', requireAuth as any, teamController.remove as any);
router.patch('/:id/role', requireAuth as any, teamController.updateRole as any);

export default router;
