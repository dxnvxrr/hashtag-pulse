import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { RingOutcome } from './progression.js';
import { dayKeyIn, recordPlay, type StreakResult, type StreakState } from './streak.js';

export interface LifetimeStats {
  perfects: number;
  cleans: number;
  closes: number;
  rankedRuns: number;
}

const EMPTY: LifetimeStats = { perfects: 0, cleans: 0, closes: 0, rankedRuns: 0 };

/** The lives a challenge compares (Ranked's 5, before any ad refill). */
export const CHALLENGE_LIVES = 5;

/** Hits and average |delta| within the first 5 lives: what challenge links compare. Same rule as Web/game.js. */
export function challengeScore(rings: RingOutcome[]): { hits: number; avgUs: number } {
  let misses = 0;
  let hits = 0;
  let sum = 0;
  for (const r of rings) {
    if (r.verdict === 'MISS') {
      if (++misses >= CHALLENGE_LIVES) break;
      continue;
    }
    hits++;
    sum += Math.abs(r.deltaUs ?? 0);
  }
  return { hits, avgUs: hits ? Math.round(sum / hits) : 0 };
}

/** Verdicts that count toward lifetime stats. Slow-Mo rings don't: tickets can be bought, and stats measure skill. */
export function statCounts(rings: RingOutcome[]): { perfects: number; cleans: number; closes: number } {
  const c = { perfects: 0, cleans: 0, closes: 0 };
  for (const r of rings) {
    if (r.slow) continue;
    if (r.verdict === 'PERFECT') c.perfects++;
    else if (r.verdict === 'CLEAN') c.cleans++;
    else if (r.verdict === 'CLOSE') c.closes++;
  }
  return c;
}

export interface RankedRunTotals {
  lifetime: LifetimeStats;
  daily: StreakResult;
}

/**
 * Adds one verified Ranked run to the player's lifetime totals and daily streak (inside the run's submit
 * transaction; the row lock serialises concurrent submits).
 */
export async function addRankedRun(
  tx: Prisma.TransactionClient,
  userId: string,
  c: ReturnType<typeof statCounts>,
  timeZone: string | null,
  now: Date,
): Promise<RankedRunTotals> {
  const row = await tx.playerStats.upsert({
    where: { userId },
    create: { userId, ...c, rankedRuns: 1 },
    update: {
      perfects: { increment: c.perfects },
      cleans: { increment: c.cleans },
      closes: { increment: c.closes },
      rankedRuns: { increment: 1 },
    },
  });
  const daily = recordPlay(streakOf(row), dayKeyIn(timeZone, now));
  if (daily.event !== 'same-day') {
    const s = daily.state;
    await tx.playerStats.update({
      where: { userId },
      data: { dailyLast: s.last, dailyStreak: s.streak, dailyBest: s.best, anchors: s.anchors, dailyPlayed: s.played },
    });
  }
  return { lifetime: pick(row), daily };
}

type StatsRow = { dailyLast: string | null; dailyStreak: number; dailyBest: number; anchors: number; dailyPlayed: string[] };

function streakOf(row: StatsRow): StreakState {
  return { last: row.dailyLast, streak: row.dailyStreak, best: row.dailyBest, anchors: row.anchors, played: row.dailyPlayed };
}

/** Lifetime totals and the daily streak, for the profile. */
export async function getPlayerStats(userId: string): Promise<{ lifetime: LifetimeStats; daily: StreakState }> {
  const row = await prisma.playerStats.findUnique({ where: { userId } });
  return row ? { lifetime: pick(row), daily: streakOf(row) } : { lifetime: { ...EMPTY }, daily: { last: null, streak: 0, best: 0, anchors: 0, played: [] } };
}

function pick(row: LifetimeStats): LifetimeStats {
  return { perfects: row.perfects, cleans: row.cleans, closes: row.closes, rankedRuns: row.rankedRuns };
}
