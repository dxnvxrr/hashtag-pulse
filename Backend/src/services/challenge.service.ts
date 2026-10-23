import { prisma } from '../lib/prisma.js';

/** More hits wins; on equal hits the lower average delta wins. Same rule as Web/progress.js compareChallenge. */
export function compareScores(mine: { hits: number; avgUs: number }, theirs: { hits: number; avgUs: number }): 'win' | 'lose' | 'tie' {
  if (mine.hits !== theirs.hits) return mine.hits > theirs.hits ? 'win' : 'lose';
  if (mine.avgUs === theirs.avgUs) return 'tie';
  return mine.avgUs < theirs.avgUs ? 'win' : 'lose';
}

/** Friends who played your challenge links (server-verified runs), newest first, scored from your side. */
export async function challengeInbox(userId: string, limit = 20) {
  const rows = await prisma.$queryRaw<
    Array<{ at: Date; hits: number; avgUs: number; myHits: number; myAvgUs: number; name: string | null }>
  >`
    SELECT d."submittedAt" AS at, d."scoreHits" AS hits, d."scoreAvgUs" AS "avgUs",
           o."scoreHits" AS "myHits", o."scoreAvgUs" AS "myAvgUs", u."displayName" AS name
    FROM "runs" d
    JOIN "runs" o ON o."id" = d."challengeRunId"
    JOIN "users" u ON u."id" = d."userId"
    WHERE o."userId" = ${userId}::uuid AND d."userId" <> ${userId}::uuid AND d."status" = 'VALIDATED'
      AND d."scoreHits" IS NOT NULL AND o."scoreHits" IS NOT NULL
    ORDER BY d."submittedAt" DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({
    at: r.at.toISOString(),
    name: r.name ?? 'Player',
    theirs: { hits: r.hits, avgUs: r.avgUs },
    mine: { hits: r.myHits, avgUs: r.myAvgUs },
    outcome: compareScores({ hits: r.myHits, avgUs: r.myAvgUs }, { hits: r.hits, avgUs: r.avgUs }),
  }));
}
