import {
  canTransition,
  assertTransition,
} from '../../utils/transactionStateMachine';
import { TransactionStateError } from '../../errors/AppError';

describe('Transaction State Machine', () => {
  describe('canTransition', () => {
    it('should allow valid transitions from PENDING', () => {
      expect(canTransition('PENDING', 'AWAITING_SIGNATURE')).toBe(true);
      expect(canTransition('PENDING', 'FAILED')).toBe(true);
      expect(canTransition('PENDING', 'COMPLETED')).toBe(false);
      expect(canTransition('PENDING', 'SWAPPING')).toBe(false);
    });

    it('should allow valid transitions from AWAITING_SIGNATURE', () => {
      expect(canTransition('AWAITING_SIGNATURE', 'SIGNED')).toBe(true);
      expect(canTransition('AWAITING_SIGNATURE', 'FAILED')).toBe(true);
      expect(canTransition('AWAITING_SIGNATURE', 'PENDING')).toBe(false);
    });

    it('should allow valid transitions from SIGNED', () => {
      expect(canTransition('SIGNED', 'SWAPPING')).toBe(true);
      expect(canTransition('SIGNED', 'FAILED')).toBe(true);
      expect(canTransition('SIGNED', 'COMPLETED')).toBe(false);
    });

    it('should allow valid transitions from SWAPPING', () => {
      expect(canTransition('SWAPPING', 'SWAPPED')).toBe(true);
      expect(canTransition('SWAPPING', 'FAILED')).toBe(true);
      expect(canTransition('SWAPPING', 'COMPLETED')).toBe(false);
    });

    it('should allow valid transitions from SWAPPED', () => {
      expect(canTransition('SWAPPED', 'PAYOUT_PENDING')).toBe(true);
      expect(canTransition('SWAPPED', 'FAILED')).toBe(true);
      expect(canTransition('SWAPPED', 'REFUNDED')).toBe(true);
    });

    it('should allow valid transitions from PAYOUT_PENDING', () => {
      expect(canTransition('PAYOUT_PENDING', 'PAYOUT_PROCESSING')).toBe(true);
      expect(canTransition('PAYOUT_PENDING', 'FAILED')).toBe(true);
    });

    it('should allow valid transitions from PAYOUT_PROCESSING', () => {
      expect(canTransition('PAYOUT_PROCESSING', 'COMPLETED')).toBe(true);
      expect(canTransition('PAYOUT_PROCESSING', 'FAILED')).toBe(true);
    });

    it('should not allow transitions from COMPLETED (terminal state)', () => {
      expect(canTransition('COMPLETED', 'PENDING')).toBe(false);
      expect(canTransition('COMPLETED', 'REFUNDED')).toBe(false);
      expect(canTransition('COMPLETED', 'FAILED')).toBe(false);
    });

    it('should allow FAILED to transition to REFUNDED', () => {
      expect(canTransition('FAILED', 'REFUNDED')).toBe(true);
      expect(canTransition('FAILED', 'COMPLETED')).toBe(false);
      expect(canTransition('FAILED', 'PENDING')).toBe(false);
    });

    it('should not allow transitions from REFUNDED (terminal state)', () => {
      expect(canTransition('REFUNDED', 'PENDING')).toBe(false);
      expect(canTransition('REFUNDED', 'COMPLETED')).toBe(false);
    });

    it('should return false for unknown states', () => {
      expect(canTransition('UNKNOWN', 'PENDING')).toBe(false);
    });
  });

  describe('assertTransition', () => {
    it('should not throw on valid transition', () => {
      expect(() =>
        assertTransition('PENDING', 'AWAITING_SIGNATURE', 'await signature')
      ).not.toThrow();
    });

    it('should throw TransactionStateError on invalid transition', () => {
      expect(() =>
        assertTransition('COMPLETED', 'SIGNED', 'submit')
      ).toThrow(TransactionStateError);

      try {
        assertTransition('COMPLETED', 'SIGNED', 'submit');
      } catch (err: any) {
        expect(err.statusCode).toBe(409);
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.message).toContain('Cannot submit a transaction in COMPLETED state');
        expect(err.details).toEqual({
          currentState: 'COMPLETED',
          attemptedAction: 'submit',
        });
      }
    });
  });
});
