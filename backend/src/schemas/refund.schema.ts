import { z } from 'zod';

// ─── Create Refund ──────────────────────────────────────────

export const createRefundSchema = z.object({
  paymentId: z.string().min(1, 'Payment ID is required'),
  amount: z
    .number()
    .positive('Amount must be greater than 0')
    .max(1_000_000, 'Amount cannot exceed 1,000,000'),
  reason: z.string().max(500, 'Reason cannot exceed 500 characters').optional(),
  note: z.string().max(1000, 'Note cannot exceed 1000 characters').optional(),
});

// ─── List Refunds ───────────────────────────────────────────

export const listRefundsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
  status: z
    .enum(['PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED', 'REJECTED', 'FAILED'])
    .optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

// ─── Reject Refund ──────────────────────────────────────────

export const rejectRefundSchema = z.object({
  reason: z.string().min(1, 'Rejection reason is required').max(500),
});
