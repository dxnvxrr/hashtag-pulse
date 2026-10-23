-- CreateEnum
CREATE TYPE "SnapshotStatus" AS ENUM ('DRAFT', 'FINAL', 'CANCELLED');

-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "statCleans" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "statCloses" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "statPerfects" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "player_stats" (
    "userId" UUID NOT NULL,
    "perfects" INTEGER NOT NULL DEFAULT 0,
    "cleans" INTEGER NOT NULL DEFAULT 0,
    "closes" INTEGER NOT NULL DEFAULT 0,
    "rankedRuns" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "player_stats_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "airdrop_snapshots" (
    "id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "cutoffAt" TIMESTAMP(3) NOT NULL,
    "status" "SnapshotStatus" NOT NULL DEFAULT 'DRAFT',
    "weightPerfect" INTEGER NOT NULL,
    "weightClean" INTEGER NOT NULL,
    "weightClose" INTEGER NOT NULL,
    "minRankedRuns" INTEGER NOT NULL,
    "eligibleUsers" INTEGER NOT NULL DEFAULT 0,
    "totalPoints" BIGINT NOT NULL DEFAULT 0,
    "digest" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMP(3),

    CONSTRAINT "airdrop_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "airdrop_entries" (
    "snapshotId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "perfects" INTEGER NOT NULL,
    "cleans" INTEGER NOT NULL,
    "closes" INTEGER NOT NULL,
    "rankedRuns" INTEGER NOT NULL,
    "points" BIGINT NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "excludedReason" TEXT,

    CONSTRAINT "airdrop_entries_pkey" PRIMARY KEY ("snapshotId","userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "airdrop_snapshots_label_key" ON "airdrop_snapshots"("label");

-- CreateIndex
CREATE INDEX "airdrop_entries_snapshotId_eligible_idx" ON "airdrop_entries"("snapshotId", "eligible");

-- CreateIndex
CREATE INDEX "runs_mode_status_submittedAt_idx" ON "runs"("mode", "status", "submittedAt");

-- AddForeignKey
ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "airdrop_entries" ADD CONSTRAINT "airdrop_entries_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "airdrop_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "airdrop_entries" ADD CONSTRAINT "airdrop_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Counters can't go negative; weights and thresholds are non-negative.
ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_non_negative"
  CHECK ("perfects" >= 0 AND "cleans" >= 0 AND "closes" >= 0 AND "rankedRuns" >= 0);
ALTER TABLE "airdrop_snapshots" ADD CONSTRAINT "airdrop_snapshots_weights"
  CHECK ("weightPerfect" >= 0 AND "weightClean" >= 0 AND "weightClose" >= 0 AND "minRankedRuns" >= 0);

-- Backfill. Runs from before this migration didn't record which rings used Slow-Mo, so their full counts carry over.
UPDATE "runs" SET "statPerfects" = "perfects", "statCleans" = "cleans", "statCloses" = "closes"
  WHERE "mode" = 'RANKED' AND "status" = 'VALIDATED';
INSERT INTO "player_stats" ("userId", "perfects", "cleans", "closes", "rankedRuns", "updatedAt")
  SELECT "userId", SUM("statPerfects"), SUM("statCleans"), SUM("statCloses"), COUNT(*), now()
  FROM "runs" WHERE "mode" = 'RANKED' AND "status" = 'VALIDATED' GROUP BY "userId";

-- A FINAL snapshot is a commitment to players: it can't be edited, re-opened or deleted.
CREATE OR REPLACE FUNCTION airdrop_snapshots_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'FINAL' THEN RAISE EXCEPTION 'a FINAL airdrop snapshot cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'airdrop snapshot % is % and cannot change', OLD."label", OLD."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "airdrop_snapshots_frozen" BEFORE UPDATE OR DELETE ON "airdrop_snapshots"
  FOR EACH ROW EXECUTE FUNCTION airdrop_snapshots_guard();

-- Entries are written once. Deletes stay possible so account erasure (GDPR/CCPA) can cascade; erased players
-- simply drop out of the snapshot, and the archived export plus the digest still prove what was finalised.
CREATE OR REPLACE FUNCTION airdrop_entries_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'airdrop entries are write-once';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "airdrop_entries_write_once" BEFORE UPDATE ON "airdrop_entries"
  FOR EACH ROW EXECUTE FUNCTION airdrop_entries_guard();
