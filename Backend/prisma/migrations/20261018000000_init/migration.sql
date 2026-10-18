-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'QUARANTINED', 'BANNED', 'PENDING_DELETION');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('IOS', 'ANDROID', 'EDITOR');

-- CreateEnum
CREATE TYPE "IdentityProvider" AS ENUM ('APPLE', 'GOOGLE_PLAY_GAMES');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('TICKS', 'CORES', 'SLOWMO_TICKETS', 'ANCHORS');

-- CreateEnum
CREATE TYPE "TransactionReason" AS ENUM ('RUN_REWARD', 'IAP_PURCHASE', 'AD_REWARD', 'ITEM_PURCHASE', 'ACCOUNT_MERGE', 'ADMIN_ADJUSTMENT', 'REFUND_REVERSAL');

-- CreateEnum
CREATE TYPE "Store" AS ENUM ('APP_STORE', 'GOOGLE_PLAY');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('VERIFIED', 'REJECTED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "RunMode" AS ENUM ('PULSE', 'GAUNTLET', 'DUEL', 'ZEN');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('ACTIVE', 'VALIDATED', 'QUARANTINED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AdRewardStatus" AS ENUM ('PENDING', 'GRANTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "precisionRating" INTEGER NOT NULL DEFAULT 1000,
    "bestDeltaUs" INTEGER,
    "isMinor" BOOLEAN NOT NULL DEFAULT false,
    "ageGateAnsweredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletionRequestedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "fingerprintHash" VARCHAR(64) NOT NULL,
    "platform" "Platform" NOT NULL,
    "model" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identities" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "IdentityProvider" NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "familyId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "userId" UUID NOT NULL,
    "ticks" BIGINT NOT NULL DEFAULT 0,
    "cores" BIGINT NOT NULL DEFAULT 0,
    "slowMoTickets" INTEGER NOT NULL DEFAULT 3,
    "anchors" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "reason" "TransactionReason" NOT NULL,
    "idempotencyKey" VARCHAR(200) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "store" "Store" NOT NULL,
    "productId" VARCHAR(128) NOT NULL,
    "storeTransactionId" VARCHAR(255) NOT NULL,
    "status" "PurchaseStatus" NOT NULL,
    "environment" VARCHAR(32) NOT NULL,
    "verifiedPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "mode" "RunMode" NOT NULL,
    "seed" BIGINT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'ACTIVE',
    "baseDurationMs" INTEGER NOT NULL,
    "ftue" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" TIMESTAMP(3),
    "ringsPlayed" INTEGER NOT NULL DEFAULT 0,
    "perfects" INTEGER NOT NULL DEFAULT 0,
    "cleans" INTEGER NOT NULL DEFAULT 0,
    "closes" INTEGER NOT NULL DEFAULT 0,
    "misses" INTEGER NOT NULL DEFAULT 0,
    "totalDeltaUs" BIGINT NOT NULL DEFAULT 0,
    "bestDeltaUs" INTEGER,
    "ticksAwarded" INTEGER NOT NULL DEFAULT 0,
    "flags" TEXT[],

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_rewards" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "placement" VARCHAR(64) NOT NULL,
    "status" "AdRewardStatus" NOT NULL DEFAULT 'PENDING',
    "networkEventId" VARCHAR(128),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "grantedAt" TIMESTAMP(3),

    CONSTRAINT "ad_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "userId" UUID,
    "action" VARCHAR(64) NOT NULL,
    "severity" VARCHAR(16) NOT NULL,
    "ip" VARCHAR(64),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "devices_fingerprintHash_key" ON "devices"("fingerprintHash");

-- CreateIndex
CREATE INDEX "devices_userId_idx" ON "devices"("userId");

-- CreateIndex
CREATE INDEX "identities_userId_idx" ON "identities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "identities_provider_subject_key" ON "identities"("provider", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "refresh_tokens_familyId_idx" ON "refresh_tokens"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_idempotencyKey_key" ON "transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "transactions_userId_createdAt_idx" ON "transactions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "purchases_userId_idx" ON "purchases"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_store_storeTransactionId_key" ON "purchases"("store", "storeTransactionId");

-- CreateIndex
CREATE INDEX "runs_userId_startedAt_idx" ON "runs"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "runs_status_idx" ON "runs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ad_rewards_networkEventId_key" ON "ad_rewards"("networkEventId");

-- CreateIndex
CREATE INDEX "ad_rewards_userId_createdAt_idx" ON "ad_rewards"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identities" ADD CONSTRAINT "identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_rewards" ADD CONSTRAINT "ad_rewards_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ACID guard rails: balances can never go negative, even if application code has a bug.
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_ticks_non_negative" CHECK ("ticks" >= 0);
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_cores_non_negative" CHECK ("cores" >= 0);
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_slowmo_non_negative" CHECK ("slowMoTickets" >= 0);
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_anchors_non_negative" CHECK ("anchors" >= 0);
ALTER TABLE "users" ADD CONSTRAINT "users_rating_range" CHECK ("precisionRating" BETWEEN 0 AND 3000);

-- The ledger and audit log are append-only. DELETE stays allowed so GDPR erasure (user cascade) works.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "transactions_append_only" BEFORE UPDATE ON "transactions"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER "audit_logs_append_only" BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
