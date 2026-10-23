-- CreateEnum
CREATE TYPE "Region" AS ENUM ('NA', 'SA', 'EU', 'AF', 'ME', 'AS', 'OC');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('AWAITING_VERIFICATION', 'VERIFIED', 'PAID', 'FORFEITED', 'EXPIRED');

-- AlterTable
ALTER TABLE "airdrop_snapshots" ADD COLUMN     "fromAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "player_stats" ADD COLUMN     "anchors" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dailyBest" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dailyLast" TEXT,
ADD COLUMN     "dailyPlayed" TEXT[],
ADD COLUMN     "dailyStreak" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "challengeRunId" UUID,
ADD COLUMN     "scoreAvgUs" INTEGER,
ADD COLUMN     "scoreHits" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "isAdult" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "region" "Region",
ADD COLUMN     "regionChangedAt" TIMESTAMP(3),
ADD COLUMN     "timeZone" TEXT;

-- CreateTable
CREATE TABLE "prize_seasons" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "snapshotId" UUID NOT NULL,
    "poolCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "capBps" INTEGER NOT NULL,
    "minPayoutCents" INTEGER NOT NULL,
    "unallocatedCents" INTEGER NOT NULL,
    "claimDeadline" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prize_seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prize_payouts" (
    "id" UUID NOT NULL,
    "seasonId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "rank" INTEGER NOT NULL,
    "halfPoints" BIGINT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'AWAITING_VERIFICATION',
    "identityRef" TEXT,
    "country" TEXT,
    "statusReason" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prize_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prize_seasons_label_key" ON "prize_seasons"("label");

-- CreateIndex
CREATE UNIQUE INDEX "prize_seasons_snapshotId_key" ON "prize_seasons"("snapshotId");

-- CreateIndex
CREATE INDEX "prize_payouts_status_idx" ON "prize_payouts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "prize_payouts_seasonId_userId_key" ON "prize_payouts"("seasonId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "prize_payouts_seasonId_identityRef_key" ON "prize_payouts"("seasonId", "identityRef");

-- CreateIndex
CREATE INDEX "runs_challengeRunId_idx" ON "runs"("challengeRunId");

-- AddForeignKey
ALTER TABLE "prize_seasons" ADD CONSTRAINT "prize_seasons_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "airdrop_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prize_payouts" ADD CONSTRAINT "prize_payouts_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "prize_seasons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prize_payouts" ADD CONSTRAINT "prize_payouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "prize_seasons" ADD CONSTRAINT "prize_seasons_amounts"
  CHECK ("poolCents" >= 0 AND "capBps" BETWEEN 1 AND 10000 AND "minPayoutCents" >= 0 AND "unallocatedCents" >= 0);
ALTER TABLE "prize_payouts" ADD CONSTRAINT "prize_payouts_amount" CHECK ("amountCents" > 0 AND "rank" > 0);

-- A won amount is a promise: who won, their rank and the amount never change after the season is created.
-- Only the payment lifecycle moves (status, verification and payment fields).
CREATE OR REPLACE FUNCTION prize_payouts_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."seasonId" <> OLD."seasonId" OR NEW."userId" <> OLD."userId" OR NEW."rank" <> OLD."rank"
     OR NEW."halfPoints" <> OLD."halfPoints" OR NEW."amountCents" <> OLD."amountCents" THEN
    RAISE EXCEPTION 'prize payout amounts are fixed once awarded';
  END IF;
  IF OLD."status" IN ('PAID', 'FORFEITED', 'EXPIRED') AND NEW."status" <> OLD."status" THEN
    RAISE EXCEPTION 'prize payout is % and cannot change status', OLD."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "prize_payouts_fixed" BEFORE UPDATE ON "prize_payouts"
  FOR EACH ROW EXECUTE FUNCTION prize_payouts_guard();

CREATE OR REPLACE FUNCTION prize_seasons_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'prize seasons are write-once';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "prize_seasons_write_once" BEFORE UPDATE OR DELETE ON "prize_seasons"
  FOR EACH ROW EXECUTE FUNCTION prize_seasons_guard();
