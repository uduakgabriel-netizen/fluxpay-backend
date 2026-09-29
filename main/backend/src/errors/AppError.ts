export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500,
    public code: string = 'INTERNAL_ERROR',
    public details?: any
  ) {
    super(message);
    this.name = 'AppError';
    if (!this.code) {
      if (statusCode === 400) this.code = 'BAD_REQUEST';
      else if (statusCode === 401) this.code = 'AUTH_ERROR';
      else if (statusCode === 403) this.code = 'FORBIDDEN';
      else if (statusCode === 404) this.code = 'NOT_FOUND';
      else if (statusCode === 409) this.code = 'CONFLICT';
      else if (statusCode === 410) this.code = 'GONE';
      else if (statusCode === 422) this.code = 'UNPROCESSABLE_ENTITY';
      else if (statusCode === 502) this.code = 'PROVIDER_ERROR';
      else this.code = 'INTERNAL_ERROR';
    }
    Error.captureStackTrace?.(this, this.constructor);
  }
}

// Specific error classes
export class ValidationError extends AppError {
  constructor(message: string, details?: any) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class AuthError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 401, 'AUTH_ERROR');
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Access denied') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: string = 'CONFLICT') {
    super(message, 409, code);
  }
}

export class ProviderError extends AppError {
  constructor(message: string, provider: string, details?: any) {
    super(message, 502, 'PROVIDER_ERROR', { provider, ...details });
  }
}

export class InsufficientFundsError extends AppError {
  constructor(message: string = 'Insufficient balance') {
    super(message, 422, 'INSUFFICIENT_FUNDS');
  }
}

export class QuoteExpiredError extends AppError {
  constructor() {
    super('Quote has expired. Please request a new quote.', 410, 'QUOTE_EXPIRED');
  }
}

export class TransactionStateError extends AppError {
  constructor(currentState: string, attemptedAction: string) {
    super(
      `Cannot ${attemptedAction} a transaction in ${currentState} state`,
      409,
      'INVALID_STATE_TRANSITION',
      { currentState, attemptedAction }
    );
  }
}
