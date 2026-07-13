import { z } from 'zod';

// ─── Supported Webhook Events ───────────────────────────────

export const WEBHOOK_EVENTS = [
  'payment.created',
  'payment.completed',
  'payment.failed',
  'payment.expired',
  'refund.created',
  'refund.completed',
  'refund.rejected',
  'settlement.created',
  'settlement.completed',
  'settlement.failed',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

// ─── Update Webhook Config ──────────────────────────────────

export const updateWebhookSchema = z.object({
  url: z
    .string()
    .url('Must be a valid URL')
    .refine((u) => u.startsWith('https://'), 'Webhook URL must use HTTPS'),
  events: z
    .array(
      z.enum(WEBHOOK_EVENTS, {
        errorMap: () => ({ message: `Event must be one of: ${WEBHOOK_EVENTS.join(', ')}` }),
      })
    )
    .min(1, 'At least one event must be selected'),
  active: z.boolean().default(true),
  maxRetries: z.number().int().min(1).max(10).default(5),
});

// ─── List Webhook Logs ──────────────────────────────────────

export const listWebhookLogsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
  event: z.string().optional(),
  status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'RETRYING']).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});
