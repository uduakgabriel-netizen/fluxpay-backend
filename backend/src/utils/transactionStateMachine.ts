import { TransactionStateError } from '../errors/AppError';

const VALID_TRANSITIONS: Record<string, string[]> = {
  INITIATED: ['AWAITING_SIGNATURE', 'FAILED'],
  PENDING: ['AWAITING_SIGNATURE', 'FAILED'],
  AWAITING_SIGNATURE: ['BROADCASTING', 'SIGNED', 'SWAPPING', 'FAILED'],
  SIGNED: ['BROADCASTING', 'SWAPPING', 'FAILED'],
  BROADCASTING: ['CRYPTO_RECEIVED', 'SWAPPING', 'SWAPPED', 'FAILED'],
  SWAPPING: ['SWAPPED', 'CRYPTO_RECEIVED', 'FAILED'],
  SWAPPED: ['CRYPTO_RECEIVED', 'FIAT_PROCESSING', 'PAYOUT_PENDING', 'FAILED', 'REFUNDED'],
  CRYPTO_RECEIVED: ['FIAT_PROCESSING', 'PAYOUT_PROCESSING', 'PAYOUT_PENDING', 'FAILED', 'REFUNDED'],
  PAYOUT_PENDING: ['FIAT_PROCESSING', 'PAYOUT_PROCESSING', 'FAILED'],
  PAYOUT_PROCESSING: ['COMPLETED', 'FAILED'],
  FIAT_PROCESSING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: ['REFUNDED'],
  REFUNDED: []
};

export function canTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: string, to: string, action: string): void {
  if (!canTransition(from, to)) {
    throw new TransactionStateError(from, action);
  }
}
