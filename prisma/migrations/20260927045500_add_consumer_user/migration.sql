-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumer_nonces" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consumer_nonces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_walletAddress_key" ON "users"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "consumer_nonces_walletAddress_key" ON "consumer_nonces"("walletAddress");

-- AlterTable
ALTER TABLE "supported_tokens" ADD COLUMN IF NOT EXISTS "logoURI" TEXT,
ALTER COLUMN "rank" DROP NOT NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "supported_tokens_isActive_idx" ON "supported_tokens"("isActive");

-- CreateTable
CREATE TABLE IF NOT EXISTS "quotes" (
    "id" TEXT NOT NULL,
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
    "route" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "bank_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "merchantId" TEXT,
    "accountName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'oneLiquidity',
    "providerRefId" TEXT,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "quotes_userId_idx" ON "quotes"("userId");
CREATE INDEX IF NOT EXISTS "quotes_merchantId_idx" ON "quotes"("merchantId");
CREATE INDEX IF NOT EXISTS "quotes_expiresAt_idx" ON "quotes"("expiresAt");
CREATE INDEX IF NOT EXISTS "quotes_used_idx" ON "quotes"("used");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bank_accounts_userId_idx" ON "bank_accounts"("userId");
CREATE INDEX IF NOT EXISTS "bank_accounts_merchantId_idx" ON "bank_accounts"("merchantId");
CREATE INDEX IF NOT EXISTS "bank_accounts_isDefault_idx" ON "bank_accounts"("isDefault");


