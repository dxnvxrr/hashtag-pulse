import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';

/**
 * Rails for a future token distribution: a frozen, auditable snapshot of every player's Ranked skill score.
 *
 * Scores are recomputed from the runs table (server-verified Ranked runs only), never from the display counters,
 * so a run that anti-cheat quarantines or rejects carries no credit. Slow-Mo rings never count. Nothing here moves
 * money or tokens, collects wallet addresses, or is reachable over HTTP: it runs only from the operator CLI.
 */

export interface SnapshotOptions {
  label: string;
  cutoffAt: Date;
  /** Points per verdict. Default 4/3/2, the same 2 : 1.5 : 1 ratio as the Prestige circle. */
  weights?: { perfect: number; clean: number; close: number };
  /** Players need at least this many verified Ranked runs (a cheap filter against throwaway farm accounts). */
  minRankedRuns?: number;
}

export const DEFAULT_WEIGHTS = { perfect: 4, clean: 3, close: 2 };

export async function createSnapshot(opts: SnapshotOptions) {
  const w = opts.weights ?? DEFAULT_WEIGHTS;
  const minRuns = opts.minRankedRuns ?? 10;
  if (opts.cutoffAt.getTime() > Date.now()) throw new Error('cutoff must not be in the future');
  if (![w.perfect, w.clean, w.close, minRuns].every((n) => Number.isInteger(n) && n >= 0)) throw new Error('weights and minRankedRuns must be non-negative integers');

  return prisma.$transaction(
    async (tx) => {
      const snap = await tx.airdropSnapshot.create({
        data: { label: opts.label, cutoffAt: opts.cutoffAt, weightPerfect: w.perfect, weightClean: w.clean, weightClose: w.close, minRankedRuns: minRuns },
      });
      // One pass over the run ledger. Exclusion order: the first matching reason is recorded.
      await tx.$executeRaw`
        INSERT INTO "airdrop_entries" ("snapshotId", "userId", "perfects", "cleans", "closes", "rankedRuns", "points", "eligible", "excludedReason")
        SELECT ${snap.id}::uuid, u."id", s.p, s.c, s.cl, s.runs,
               s.p::bigint * ${w.perfect} + s.c::bigint * ${w.clean} + s.cl::bigint * ${w.close},
               reason IS NULL, reason
        FROM (
          SELECT r."userId",
                 COALESCE(SUM(r."statPerfects") FILTER (WHERE r."status" = 'VALIDATED'), 0)::int AS p,
                 COALESCE(SUM(r."statCleans")   FILTER (WHERE r."status" = 'VALIDATED'), 0)::int AS c,
                 COALESCE(SUM(r."statCloses")   FILTER (WHERE r."status" = 'VALIDATED'), 0)::int AS cl,
                 COUNT(*) FILTER (WHERE r."status" = 'VALIDATED')::int AS runs,
                 COUNT(*) FILTER (WHERE r."status" IN ('QUARANTINED', 'REJECTED'))::int AS flagged
          FROM "runs" r
          WHERE r."mode" = 'RANKED' AND r."submittedAt" < ${opts.cutoffAt}
          GROUP BY r."userId"
        ) s
        JOIN "users" u ON u."id" = s."userId"
        CROSS JOIN LATERAL (SELECT CASE
          WHEN u."isMinor" THEN 'minor'
          WHEN u."status" = 'PENDING_DELETION' OR u."deletionRequestedAt" IS NOT NULL THEN 'deletion_pending'
          WHEN u."status" <> 'ACTIVE' THEN 'account_status'
          WHEN s.flagged > 0 THEN 'anticheat_review'
          WHEN s.runs < ${minRuns} THEN 'too_few_runs'
        END AS reason) x`;
      const totals = await tx.airdropEntry.aggregate({ where: { snapshotId: snap.id, eligible: true }, _count: true, _sum: { points: true } });
      const updated = await tx.airdropSnapshot.update({
        where: { id: snap.id },
        data: { eligibleUsers: totals._count, totalPoints: totals._sum.points ?? 0n },
      });
      await audit('airdrop.snapshot_created', { severity: 'info', metadata: { snapshotId: snap.id, label: opts.label, eligibleUsers: totals._count } });
      return updated;
    },
    { timeout: 10 * 60_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** Streams the eligible entries in a fixed order: the same rows the digest covers and the export prints. */
export async function* eligibleEntries(snapshotId: string, batch = 10_000) {
  let after: string | undefined;
  for (;;) {
    const rows = await prisma.airdropEntry.findMany({
      where: { snapshotId, eligible: true, ...(after ? { userId: { gt: after } } : {}) },
      orderBy: { userId: 'asc' },
      select: { userId: true, points: true },
      take: batch,
    });
    yield* rows;
    if (rows.length < batch) return;
    after = rows[rows.length - 1]!.userId;
  }
}

/** sha256 of "userId,points\n" lines in user-id order. Anyone holding the export can recompute it. */
export async function snapshotDigest(snapshotId: string): Promise<string> {
  const h = createHash('sha256');
  for await (const e of eligibleEntries(snapshotId)) h.update(`${e.userId},${e.points}\n`);
  return h.digest('hex');
}

/** Freezes a DRAFT snapshot. After this the database refuses any change to it. */
export async function finalizeSnapshot(label: string) {
  const snap = await prisma.airdropSnapshot.findUniqueOrThrow({ where: { label } });
  if (snap.status !== 'DRAFT') throw new Error(`snapshot ${label} is ${snap.status}`);
  const digest = await snapshotDigest(snap.id);
  const done = await prisma.airdropSnapshot.update({ where: { id: snap.id }, data: { status: 'FINAL', digest, finalizedAt: new Date() } });
  await audit('airdrop.snapshot_finalized', { severity: 'warn', metadata: { snapshotId: snap.id, label, digest } });
  return done;
}

export async function cancelSnapshot(label: string) {
  const snap = await prisma.airdropSnapshot.findUniqueOrThrow({ where: { label } });
  if (snap.status !== 'DRAFT') throw new Error(`snapshot ${label} is ${snap.status}`);
  return prisma.airdropSnapshot.update({ where: { id: snap.id }, data: { status: 'CANCELLED' } });
}

export function exclusionSummary(snapshotId: string) {
  return prisma.airdropEntry.groupBy({ by: ['excludedReason'], where: { snapshotId }, _count: true });
}
