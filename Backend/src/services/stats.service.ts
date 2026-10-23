import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import type { RingOutcome } from './progression.js';

export interface LifetimeStats {
  perfects: number;
  cleans: number;
  closes: number;
  rankedRuns: number;
}

const EMPTY: LifetimeStats = { perfects: 0, cleans: 0, closes: 0, rankedRuns: 0 };

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

/** Adds one verified Ranked run to the player's lifetime totals (inside the run's submit transaction). */
export async function addRankedRun(tx: Prisma.TransactionClient, userId: string, c: ReturnType<typeof statCounts>): Promise<LifetimeStats> {
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
  return pick(row);
}

export async function getLifetimeStats(userId: string): Promise<LifetimeStats> {
  const row = await prisma.playerStats.findUnique({ where: { userId } });
  return row ? pick(row) : { ...EMPTY };
}

function pick(row: LifetimeStats): LifetimeStats {
  return { perfects: row.perfects, cleans: row.cleans, closes: row.closes, rankedRuns: row.rankedRuns };
}
