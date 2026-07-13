import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';
import { nonceSchema, verifySchema, signupSchema } from '../schemas/auth.schema';

const router = Router();

// Public routes
router.post('/nonce', validate(nonceSchema), authController.getNonce);
router.post('/verify', validate(verifySchema), authController.verify);
router.post('/signup', validate(signupSchema), authController.signup);

// Protected routes
router.get('/me', requireAuth as any, authController.me as any);
router.patch('/profile', requireAuth as any, authController.updateProfile as any);
router.post('/logout', requireAuth as any, authController.logout as any);

export default router;
