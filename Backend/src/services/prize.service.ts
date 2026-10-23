import type { PayoutStatus } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { createSnapshot, snapshotDigest } from './airdrop.service.js';
import { seasonBounds } from './leaderboard.service.js';
import { allocatePool, type Allocation } from './prizes.js';

/**
 * Monthly skill-prize seasons (Option B: a fixed share of ad revenue paid as cash prizes for skill, no token).
 *
 * Operator flow (src/cli/season.ts), after a month ends:
 *   1. preview  — snapshot the month's verified Ranked points (DRAFT) and print the split for review.
 *   2. review   — top earners with the signals worth a human look.
 *   3. award    — finalise the snapshot and write the payouts (amounts are then fixed by a database trigger).
 *   4. winners verify identity, age (18+) and country with the provider; verifyPayout() records the result.
 *   5. export the VERIFIED payouts for the payout provider, then markPaid() with its batch id.
 * Unverified payouts expire at the claim deadline; forfeited and expired money rolls into the next pool.
 */

export const CLAIM_DAYS = 90;
export const DEFAULT_CAP_BPS = 500; // 5% of the pool
export const DEFAULT_MIN_PAYOUT_CENTS = 500; // $5
export const DEFAULT_MIN_RUNS = 10;

export interface SeasonTerms {
  poolCents: number;
  capBps?: number;
  minPayoutCents?: number;
  minRankedRuns?: number;
}

const snapshotLabel = (season: string) => `season-${season}`;

function assertSeason(season: string): { start: Date; end: Date } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(season)) throw new Error('season must look like 2026-10');
  const b = seasonBounds(season);
  if (b.end.getTime() > Date.now()) throw new Error(`season ${season} has not ended yet`);
  return b;
}

async function allocationFor(snapshotId: string, terms: SeasonTerms): Promise<Allocation & { capCents: number; minCents: number }> {
  const capCents = Math.floor((terms.poolCents * (terms.capBps ?? DEFAULT_CAP_BPS)) / 10_000);
  const minCents = terms.minPayoutCents ?? DEFAULT_MIN_PAYOUT_CENTS;
  const entries = await prisma.airdropEntry.findMany({
    where: { snapshotId, eligible: true },
    select: { userId: true, points: true },
  });
  return {
    ...allocatePool(entries, terms.poolCents, capCents, minCents),
    capCents,
    minCents,
  };
}

/** Step 1: a DRAFT snapshot of the month and the split it would produce. Re-running replaces the draft. */
export async function previewSeason(season: string, terms: SeasonTerms) {
  const { start, end } = assertSeason(season);
  const label = snapshotLabel(season);
  const existing = await prisma.airdropSnapshot.findUnique({
    where: { label },
  });
  if (existing?.status === 'FINAL') throw new Error(`season ${season} was already awarded`);
  if (existing) await prisma.airdropSnapshot.delete({ where: { id: existing.id } });
  const snap = await createSnapshot({
    label,
    fromAt: start,
    cutoffAt: end,
    minRankedRuns: terms.minRankedRuns ?? DEFAULT_MIN_RUNS,
  });
  return { snapshot: snap, ...(await allocationFor(snap.id, terms)) };
}

/** Step 2: the top earners and the signals a reviewer should look at before money moves. */
export async function reviewSeason(season: string, limit = 50) {
  const snap = await prisma.airdropSnapshot.findUniqueOrThrow({
    where: { label: snapshotLabel(season) },
  });
  const top = await prisma.airdropEntry.findMany({
    where: { snapshotId: snap.id, eligible: true },
    orderBy: { points: 'desc' },
    take: limit,
    select: {
      userId: true,
      points: true,
      perfects: true,
      cleans: true,
      closes: true,
      rankedRuns: true,
    },
  });
  const ids = top.map((t) => t.userId);
  const [users, devices, deltas] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true, createdAt: true, region: true },
    }),
    prisma.device.groupBy({
      by: ['userId'],
      where: { userId: { in: ids } },
      _count: true,
    }),
    prisma.run.groupBy({
      by: ['userId'],
      where: {
        userId: { in: ids },
        mode: 'RANKED',
        status: 'VALIDATED',
        submittedAt: { gte: snap.fromAt ?? new Date(0), lt: snap.cutoffAt },
      },
      _sum: { totalDeltaUs: true, perfects: true, cleans: true, closes: true },
    }),
  ]);
  const u = new Map(users.map((x) => [x.id, x]));
  const d = new Map(devices.map((x) => [x.userId, x._count]));
  const r = new Map(deltas.map((x) => [x.userId, x]));
  return top.map((t) => {
    const runs = r.get(t.userId);
    const hits = (runs?._sum.perfects ?? 0) + (runs?._sum.cleans ?? 0) + (runs?._sum.closes ?? 0);
    const hitsTotal = t.perfects + t.cleans + t.closes;
    return {
      userId: t.userId,
      name: u.get(t.userId)?.displayName ?? null,
      region: u.get(t.userId)?.region ?? null,
      accountAgeDays: Math.floor((Date.now() - (u.get(t.userId)?.createdAt.getTime() ?? Date.now())) / 86_400_000),
      devices: d.get(t.userId) ?? 0,
      runs: t.rankedRuns,
      // Shown like the leaderboard: PERFECT 2, CLEAN 1.5, SO CLOSE 1.
      points: Number(t.points) / 2,
      // Bots tend to be inhumanly consistent: a very high PERFECT share and a tiny average delta.
      perfectShare: hitsTotal ? Number((t.perfects / hitsTotal).toFixed(3)) : 0,
      avgDeltaMs: hits ? Number((Number(runs?._sum.totalDeltaUs ?? 0n) / hits / 1000).toFixed(2)) : null,
    };
  });
}

/** Step 3: freeze the month and write the payouts. */
export async function awardSeason(season: string, terms: SeasonTerms) {
  assertSeason(season);
  const label = snapshotLabel(season);
  const snap = await prisma.airdropSnapshot.findUniqueOrThrow({
    where: { label },
  });
  if (snap.status === 'FINAL') throw new Error(`season ${season} was already awarded`);
  if (snap.status !== 'DRAFT') throw new Error(`snapshot ${label} is ${snap.status}; run preview again`);
  const plan = await allocationFor(snap.id, terms);
  const digest = await snapshotDigest(snap.id);
  const claimDeadline = new Date(Date.now() + CLAIM_DAYS * 86_400_000);
  // Freezing the snapshot and writing the payouts succeed or fail together, so a failure can simply be re-run.
  const created = await prisma.$transaction(async (tx) => {
    await tx.airdropSnapshot.update({
      where: { id: snap.id },
      data: { status: 'FINAL', digest, finalizedAt: new Date() },
    });
    return tx.prizeSeason.create({
      data: {
        label: season,
        snapshotId: snap.id,
        poolCents: terms.poolCents,
        capBps: terms.capBps ?? DEFAULT_CAP_BPS,
        minPayoutCents: plan.minCents,
        unallocatedCents: plan.unallocatedCents,
        claimDeadline,
        payouts: {
          create: plan.awards.map((a) => ({
            userId: a.userId,
            rank: a.rank,
            halfPoints: a.points,
            amountCents: a.amountCents,
          })),
        },
      },
    });
  });
  await audit('prizes.season_awarded', {
    severity: 'warn',
    metadata: {
      season,
      poolCents: terms.poolCents,
      winners: plan.awards.length,
      unallocatedCents: plan.unallocatedCents,
    },
  });
  return {
    season: created,
    winners: plan.awards.length,
    unallocatedCents: plan.unallocatedCents,
  };
}

export interface VerificationResult {
  /** The provider's opaque id for the verified person (the same person always gets the same ref). */
  identityRef: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** Age in whole years on the verification date. */
  age: number;
  passed: boolean;
}

/** Step 4: the identity provider's verdict (called from its webhook, or the CLI for manual review). */
export async function verifyPayout(payoutId: string, v: VerificationResult): Promise<PayoutStatus> {
  const p = await prisma.prizePayout.findUniqueOrThrow({
    where: { id: payoutId },
    include: { season: true },
  });
  if (p.status !== 'AWAITING_VERIFICATION') throw new Error(`payout is ${p.status}`);
  const country = v.country.toUpperCase();
  let status: PayoutStatus = 'VERIFIED';
  let reason: string | null = null;
  if (Date.now() > p.season.claimDeadline.getTime()) [status, reason] = ['EXPIRED', 'claim_deadline'];
  else if (!v.passed) [status, reason] = ['FORFEITED', 'verification_failed'];
  else if (v.age < 18) [status, reason] = ['FORFEITED', 'under_18'];
  else if (!config.PRIZE_COUNTRIES.includes(country)) [status, reason] = ['FORFEITED', 'country_ineligible'];
  else {
    const dup = await prisma.prizePayout.findFirst({
      where: {
        seasonId: p.seasonId,
        identityRef: v.identityRef,
        NOT: { id: p.id },
      },
    });
    if (dup) [status, reason] = ['FORFEITED', 'duplicate_person'];
  }
  await prisma.prizePayout.update({
    where: { id: p.id },
    data: {
      status,
      statusReason: reason,
      country,
      verifiedAt: new Date(),
      // A duplicate keeps no identity ref (the unique index allows one payout per person per season).
      ...(status === 'VERIFIED' ? { identityRef: v.identityRef } : {}),
    },
  });
  await audit('prizes.payout_verified', {
    userId: p.userId,
    severity: 'info',
    metadata: { payoutId, status, reason },
  });
  return status;
}

/** Step 5: record that the provider paid these payouts. */
export async function markPaid(payoutIds: string[], providerRef: string): Promise<number> {
  const res = await prisma.prizePayout.updateMany({
    where: { id: { in: payoutIds }, status: 'VERIFIED' },
    data: { status: 'PAID', paidAt: new Date(), providerRef },
  });
  await audit('prizes.payouts_paid', {
    severity: 'warn',
    metadata: { count: res.count, providerRef },
  });
  return res.count;
}

/** Background job: unverified payouts past the deadline expire. */
export async function expirePayouts(): Promise<number> {
  const res = await prisma.prizePayout.updateMany({
    where: {
      status: 'AWAITING_VERIFICATION',
      season: { claimDeadline: { lt: new Date() } },
    },
    data: { status: 'EXPIRED', statusReason: 'claim_deadline' },
  });
  return res.count;
}

/** Money to roll into the next pool: never allocated, plus forfeited and expired payouts. */
export async function rolloverCents(season: string): Promise<number> {
  const s = await prisma.prizeSeason.findUniqueOrThrow({
    where: { label: season },
  });
  const lost = await prisma.prizePayout.aggregate({
    where: { seasonId: s.id, status: { in: ['FORFEITED', 'EXPIRED'] } },
    _sum: { amountCents: true },
  });
  return s.unallocatedCents + (lost._sum.amountCents ?? 0);
}

/** What a player sees: their own payouts (only when prizes are enabled). */
export async function playerPrizes(userId: string) {
  if (!config.PRIZES_ENABLED) return { enabled: false as const };
  const payouts = await prisma.prizePayout.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 12,
    include: {
      season: { select: { label: true, currency: true, claimDeadline: true } },
    },
  });
  return {
    enabled: true as const,
    rulesUrl: config.PRIZE_RULES_URL || null,
    verifyUrl: config.PRIZE_VERIFY_URL || null,
    payouts: payouts.map((p) => ({
      id: p.id,
      season: p.season.label,
      rank: p.rank,
      amountCents: p.amountCents,
      currency: p.season.currency,
      status: p.status,
      claimDeadline: p.season.claimDeadline.toISOString(),
    })),
  };
}
