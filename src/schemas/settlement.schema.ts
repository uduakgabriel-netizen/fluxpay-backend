import { z } from 'zod';

// ─── List Settlements ───────────────────────────────────────

export const listSettlementsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
  status: z
    .enum(['PROCESSING', 'COMPLETED', 'FAILED'])
    .optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

// ─── Manual Settlement ──────────────────────────────────────

export const processSettlementSchema = z.object({
  token: z.string().optional(), // Optionally filter by token
});
