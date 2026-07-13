import { Request, Response, NextFunction } from 'express';

// Extend Express Request to include merchant
export interface AuthRequest extends Request {
  merchant?: MerchantPayload;
}

// JWT payload shape
export interface MerchantPayload {
  id: string;
  walletAddress: string;
  email?: string | null;
  businessName: string;
}

// Request bodies
export interface NonceRequestBody {
  walletAddress: string;
}

export interface VerifyRequestBody {
  walletAddress: string;
  message: string;
  signature: string;
}

export interface SignupRequestBody {
  walletAddress: string;
  email?: string | null;
  businessName: string;
  message: string;
  signature: string;
  preferredTokenSymbol?: string;
}



// API Response shapes
export interface AuthResponse {
  sessionToken: string;
  merchant: {
    id: string;
    walletAddress: string;
    email?: string | null;
    businessName: string;
    preferredTokenMint?: string;
    preferredTokenSymbol?: string;
    preferredTokenDecimals?: number;
    hasSelectedToken?: boolean;
    preferredTokenUpdatedAt?: string;
  };
}

export interface NonceResponse {
  nonce: string;
  expiresAt: string;
}

export interface MeResponse {
  id: string;
  walletAddress: string;
  email?: string | null;
  businessName: string;
  emailVerified: boolean;
  createdAt: string;
  preferredTokenMint?: string;
  preferredTokenSymbol?: string;
  preferredTokenDecimals?: number;
  hasSelectedToken?: boolean;
  preferredTokenUpdatedAt?: string;
}

export interface ErrorResponse {
  error: string;
  details?: any;
}
