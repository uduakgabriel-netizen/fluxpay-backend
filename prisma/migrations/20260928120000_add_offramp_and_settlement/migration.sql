-- AlterEnum
ALTER TYPE "SettlementStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "SettlementStatus" ADD VALUE IF NOT EXISTS 'RETRYING';

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM (
  'PENDING',
  'AWAITING_SIGNATURE',
  'SIGNED',
  'SWAPPING',
  'SWAPPED',
  'PAYOUT_PENDING',
  'PAYOUT_PROCESSING',
  'COMPLETED',
  'FAILED',
  'REFUNDED'
);

-- AlterTable
ALTER TABLE "merchants"
ADD COLUMN IF NOT EXISTS "settlementType" TEXT NOT NULL DEFAULT 'CRYPTO',
ADD COLUMN IF NOT EXISTS "settlementCurrency" TEXT,
ADD COLUMN IF NOT EXISTS "defaultPayoutAccountId" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "offramp_transactions" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "userId" TEXT,
    "merchantId" TEXT,
    "sourceToken" TEXT NOT NULL,
    "sourceMint" TEXT NOT NULL,
    "sourceAmount" TEXT NOT NULL,
    "intermediateToken" TEXT NOT NULL DEFAULT 'USDC',
    "intermediateAmount" TEXT NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "fiatAmount" TEXT NOT NULL,
    "rate" TEXT NOT NULL,
    "fee" TEXT NOT NULL,
    "networkFee" TEXT NOT NULL,
    "netAmount" TEXT NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "swapTxHash" TEXT,
    "payoutRefId" TEXT,
    "bankAccountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "offramp_transactions_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "settlements"
ADD COLUMN IF NOT EXISTS "currency" TEXT NOT NULL DEFAULT 'NGN',
ADD COLUMN IF NOT EXISTS "grossAmount" TEXT NOT NULL DEFAULT '0',
ADD COLUMN IF NOT EXISTS "fiatAmount" TEXT NOT NULL DEFAULT '0',
ADD COLUMN IF NOT EXISTS "fxRate" TEXT NOT NULL DEFAULT '1',
ADD COLUMN IF NOT EXISTS "netAmount" TEXT NOT NULL DEFAULT '0',
ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'ngn-mock',
ADD COLUMN IF NOT EXISTS "providerRefId" TEXT,
ADD COLUMN IF NOT EXISTS "bankAccountId" TEXT,
ADD COLUMN IF NOT EXISTS "errorCode" TEXT,
ADD COLUMN IF NOT EXISTS "errorMessage" TEXT,
ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "settledAt" TIMESTAMP(3),
ALTER COLUMN "amount" DROP NOT NULL,
ALTER COLUMN "token" DROP NOT NULL,
ALTER COLUMN "paymentCount" DROP NOT NULL,
ALTER COLUMN "fee" TYPE TEXT USING fee::TEXT,
ALTER COLUMN "fee" DROP DEFAULT,
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- CreateIndexes
CREATE INDEX IF NOT EXISTS "offramp_transactions_userId_idx" ON "offramp_transactions"("userId");
CREATE INDEX IF NOT EXISTS "offramp_transactions_merchantId_idx" ON "offramp_transactions"("merchantId");
CREATE INDEX IF NOT EXISTS "offramp_transactions_status_idx" ON "offramp_transactions"("status");
CREATE INDEX IF NOT EXISTS "offramp_transactions_createdAt_idx" ON "offramp_transactions"("createdAt");
CREATE INDEX IF NOT EXISTS "offramp_transactions_quoteId_idx" ON "offramp_transactions"("quoteId");

CREATE INDEX IF NOT EXISTS "settlements_createdAt_idx" ON "settlements"("createdAt");
