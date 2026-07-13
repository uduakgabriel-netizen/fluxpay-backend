import { z } from 'zod';

const walletAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Payment creation schema — Non-custodial.
 *
 * Token validation is no longer restricted to a hardcoded list.
 * Any Jupiter-supported token is accepted. Validation happens
 * at the service layer via the dynamic token registry.
 */
export const createPaymentSchema = z.object({
  amount: z
    .number()
    .positive('Amount must be greater than 0')
    .max(1_000_000, 'Amount cannot exceed 1,000,000'),
  token: z
    .string()
    .min(1, 'Token is required')
    .max(20, 'Token symbol too long')
    .transform((val) => val.toUpperCase()),
  customerEmail: z.string().email('Invalid email').optional().or(z.literal('')),
  customerWallet: z
    .string()
    .regex(walletAddressRegex, 'Invalid Solana wallet address')
    .optional()
    .or(z.literal('')),
  metadata: z.record(z.any()).optional(),
});

export const listPaymentsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  status: z
    .enum(['PENDING', 'CONFIRMED', 'COMPLETED', 'FAILED', 'EXPIRED'])
    .optional(),
  token: z.string().optional(),
  fromDate: z.string().datetime({ offset: true }).optional().or(z.string().optional()),
  toDate: z.string().datetime({ offset: true }).optional().or(z.string().optional()),
  search: z.string().optional(),
});

export const exportPaymentsSchema = z.object({
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  status: z
    .enum(['PENDING', 'CONFIRMED', 'COMPLETED', 'FAILED', 'EXPIRED'])
    .optional(),
  token: z.string().optional(),
});
