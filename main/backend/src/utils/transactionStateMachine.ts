import { TransactionStateError } from '../errors/AppError';

const VALID_TRANSITIONS: Record<string, string[]> = {
  PENDING: ['AWAITING_SIGNATURE', 'FAILED'],
  AWAITING_SIGNATURE: ['SIGNED', 'FAILED'],
  SIGNED: ['SWAPPING', 'FAILED'],
  SWAPPING: ['SWAPPED', 'FAILED'],
  SWAPPED: ['PAYOUT_PENDING', 'FAILED', 'REFUNDED'],
  PAYOUT_PENDING: ['PAYOUT_PROCESSING', 'FAILED'],
  PAYOUT_PROCESSING: ['COMPLETED', 'FAILED'],
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
