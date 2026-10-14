-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED', 'PAST_DUE');

-- CreateEnum
CREATE TYPE "SubscriptionInterval" AS ENUM ('MONTHLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('OWNER', 'ADMIN', 'DEVELOPER');

-- CreateEnum
CREATE TYPE "TeamMemberStatus" AS ENUM ('ACTIVE', 'PENDING', 'REMOVED');

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "hasSelectedToken" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "preferredTokenDecimals" INTEGER NOT NULL DEFAULT 9,
ADD COLUMN     "preferredTokenMint" TEXT NOT NULL DEFAULT 'So11111111111111111111111111111111111111112',
ADD COLUMN     "preferredTokenSymbol" TEXT NOT NULL DEFAULT 'SOL',
ADD COLUMN     "preferredTokenUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "lastSwapError" TEXT,
ADD COLUMN     "lastSwapRetryAt" TIMESTAMP(3),
ADD COLUMN     "swapRetries" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "supported_tokens" (
    "id" TEXT NOT NULL,
    "mint" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "logoUrl" TEXT,
    "rank" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supported_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "swap_quotes" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "inputMint" TEXT NOT NULL,
    "outputMint" TEXT NOT NULL,
    "inputAmount" TEXT NOT NULL,
    "expectedOutput" TEXT NOT NULL,
    "minOutputAmount" TEXT NOT NULL,
    "quote" JSONB NOT NULL,
    "slippageBps" INTEGER NOT NULL DEFAULT 100,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "swap_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "customer" TEXT NOT NULL,
    "customerEmail" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "token" TEXT NOT NULL DEFAULT 'USDC',
    "description" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "dueDate" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customer" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "token" TEXT NOT NULL DEFAULT 'USDC',
    "interval" "SubscriptionInterval" NOT NULL DEFAULT 'MONTHLY',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "nextBillingDate" TIMESTAMP(3) NOT NULL,
    "lastBilledAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'DEVELOPER',
    "status" "TeamMemberStatus" NOT NULL DEFAULT 'PENDING',
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supported_tokens_mint_key" ON "supported_tokens"("mint");

-- CreateIndex
CREATE INDEX "supported_tokens_mint_idx" ON "supported_tokens"("mint");

-- CreateIndex
CREATE INDEX "supported_tokens_symbol_idx" ON "supported_tokens"("symbol");

-- CreateIndex
CREATE INDEX "supported_tokens_rank_idx" ON "supported_tokens"("rank");

-- CreateIndex
CREATE UNIQUE INDEX "swap_quotes_paymentId_key" ON "swap_quotes"("paymentId");

-- CreateIndex
CREATE INDEX "swap_quotes_paymentId_idx" ON "swap_quotes"("paymentId");

-- CreateIndex
CREATE INDEX "swap_quotes_expiresAt_idx" ON "swap_quotes"("expiresAt");

-- CreateIndex
CREATE INDEX "invoices_merchantId_idx" ON "invoices"("merchantId");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_merchantId_invoiceNumber_key" ON "invoices"("merchantId", "invoiceNumber");

-- CreateIndex
CREATE INDEX "subscriptions_merchantId_idx" ON "subscriptions"("merchantId");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "team_members_merchantId_idx" ON "team_members"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_merchantId_email_key" ON "team_members"("merchantId", "email");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
