import { z } from 'zod';

// Solana wallet address: base58 encoded, 32-44 characters
const walletAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const nonceSchema = z.object({
  walletAddress: z
    .string()
    .regex(walletAddressRegex, 'Invalid Solana wallet address'),
});

export const verifySchema = z.object({
  walletAddress: z
    .string()
    .regex(walletAddressRegex, 'Invalid Solana wallet address'),
  message: z.string().min(1, 'Message is required'),
  signature: z.string().min(1, 'Signature is required'),
});

export const signupSchema = z.object({
  walletAddress: z
    .string()
    .regex(walletAddressRegex, 'Invalid Solana wallet address'),
  email: z.string().email('Invalid email address').optional().or(z.literal('')),
  businessName: z
    .string()
    .min(2, 'Business name must be at least 2 characters')
    .max(100, 'Business name must be at most 100 characters'),
  message: z.string().min(1, 'Message is required'),
  signature: z.string().min(1, 'Signature is required'),
  preferredTokenSymbol: z.string().optional(),
});
