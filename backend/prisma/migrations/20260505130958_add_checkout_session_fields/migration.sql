/*
  Warnings:

  - You are about to drop the column `passwordHash` on the `merchants` table. All the data in the column will be lost.
  - You are about to drop the column `privateKey` on the `payments` table. All the data in the column will be lost.
  - You are about to drop the column `receivingAddress` on the `payments` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[apiKeyHash]` on the table `merchants` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "CheckoutSessionStatus" AS ENUM ('PENDING', 'AWAITING_PAYMENT', 'PAYMENT_DETECTED', 'SWAPPING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- DropIndex
DROP INDEX "merchants_email_key";

-- DropIndex
DROP INDEX "payments_receivingAddress_idx";

-- AlterTable
ALTER TABLE "merchants" DROP COLUMN "passwordHash",
ADD COLUMN     "apiKeyHash" TEXT,
ADD COLUMN     "apiKeyLastChars" TEXT,
ADD COLUMN     "apiKeyPrefix" TEXT,
ADD COLUMN     "apiKeyRotatedAt" TIMESTAMP(3),
ADD COLUMN     "notificationSettings" JSONB,
ADD COLUMN     "webhookSecret" TEXT,
ADD COLUMN     "webhookSecretLastChars" TEXT,
ADD COLUMN     "webhookSecretPrefix" TEXT,
ADD COLUMN     "webhookSecretRotatedAt" TIMESTAMP(3),
ADD COLUMN     "webhookUrl" TEXT,
ALTER COLUMN "email" DROP NOT NULL;

-- AlterTable
ALTER TABLE "payments" DROP COLUMN "privateKey",
DROP COLUMN "receivingAddress",
ADD COLUMN     "adminAlertSent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "merchantWallet" TEXT;

-- CreateTable
CREATE TABLE "checkout_sessions" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "orderId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "token" TEXT NOT NULL DEFAULT 'USDC',
    "customerWallet" TEXT,
    "status" "CheckoutSessionStatus" NOT NULL DEFAULT 'PENDING',
    "successUrl" TEXT,
    "cancelUrl" TEXT,
    "webhookUrl" TEXT,
    "swapQuote" JSONB,
    "transactionHash" TEXT,
    "paymentId" TEXT,
    "inputToken" TEXT,
    "paidAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkout_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "checkout_sessions_paymentId_key" ON "checkout_sessions"("paymentId");

-- CreateIndex
CREATE INDEX "checkout_sessions_merchantId_idx" ON "checkout_sessions"("merchantId");

-- CreateIndex
CREATE INDEX "checkout_sessions_status_idx" ON "checkout_sessions"("status");

-- CreateIndex
CREATE INDEX "checkout_sessions_expiresAt_idx" ON "checkout_sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_apiKeyHash_key" ON "merchants"("apiKeyHash");

-- CreateIndex
CREATE INDEX "payments_merchantWallet_idx" ON "payments"("merchantWallet");

-- AddForeignKey
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
