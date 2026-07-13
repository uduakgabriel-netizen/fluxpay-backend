import { z } from 'zod';

// ─── Create API Key ─────────────────────────────────────────

export const createApiKeySchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name cannot exceed 100 characters'),
  mode: z.enum(['LIVE', 'TEST']).default('LIVE'),
  permissions: z
    .object({
      read: z.boolean().default(true),
      write: z.boolean().default(true),
      refund: z.boolean().default(false),
    })
    .default({ read: true, write: true, refund: false }),
});
