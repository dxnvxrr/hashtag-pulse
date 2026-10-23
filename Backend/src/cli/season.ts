import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { rebuildLeaderboards } from '../services/leaderboard.service.js';
import { awardSeason, markPaid, previewSeason, reviewSeason, rolloverCents, verifyPayout } from '../services/prize.service.js';

/**
 * Operator CLI for monthly prize seasons and leaderboards (no HTTP surface on purpose). From Backend/ after
 * `npm run build`. Amounts are integer cents.
 *
 *   npm run season -- preview 2026-10 <poolCents> [capBps=500] [minPayoutCents=500] [minRankedRuns=10]
 *   npm run season -- review  2026-10
 *   npm run season -- award   2026-10 <poolCents> [capBps=500] [minPayoutCents=500]
 *   npm run season -- verify  <payoutId> <identityRef> <country> <age> <pass|fail>
 *   npm run season -- export  2026-10 > payouts.csv        (VERIFIED payouts, for the payout provider)
 *   npm run season -- paid    <providerRef> <payoutId> [payoutId...]
 *   npm run season -- rollover 2026-10                     (cents to add to the next pool)
 *   npm run season -- boards-rebuild
 */
const [cmd, ...args] = process.argv.slice(2);
const int = (v: string | undefined, name: string, fallback?: number): number => {
  if (v === undefined && fallback !== undefined) return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};
const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2));
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function main() {
  switch (cmd) {
    case 'preview': {
      const [season, pool, cap, min, runs] = args;
      const p = await previewSeason(season!, {
        poolCents: int(pool, 'poolCents'),
        capBps: int(cap, 'capBps', 500),
        minPayoutCents: int(min, 'minPayoutCents', 500),
        minRankedRuns: int(runs, 'minRankedRuns', 10),
      });
      console.error(`pool ${usd(int(pool, 'poolCents'))}, cap ${usd(p.capCents)}, minimum ${usd(p.minCents)}`);
      console.error(`${p.snapshot.eligibleUsers} eligible players, ${p.awards.length} winners, ${usd(p.unallocatedCents)} unallocated`);
      out(p.awards.slice(0, 25).map((a) => ({ rank: a.rank, userId: a.userId, points: Number(a.points) / 2, amount: usd(a.amountCents) })));
      return;
    }
    case 'review':
      return out(await reviewSeason(args[0]!));
    case 'award': {
      const [season, pool, cap, min] = args;
      const r = await awardSeason(season!, { poolCents: int(pool, 'poolCents'), capBps: int(cap, 'capBps', 500), minPayoutCents: int(min, 'minPayoutCents', 500) });
      return out({ season: r.season.label, winners: r.winners, unallocated: usd(r.unallocatedCents), claimDeadline: r.season.claimDeadline });
    }
    case 'verify': {
      const [payoutId, identityRef, country, age, verdict] = args;
      if (verdict !== 'pass' && verdict !== 'fail') throw new Error('last argument must be pass or fail');
      return out({ status: await verifyPayout(payoutId!, { identityRef: identityRef!, country: country!, age: int(age, 'age'), passed: verdict === 'pass' }) });
    }
    case 'export': {
      const s = await prisma.prizeSeason.findUniqueOrThrow({ where: { label: args[0]! } });
      const rows = await prisma.prizePayout.findMany({ where: { seasonId: s.id, status: 'VERIFIED' }, orderBy: { rank: 'asc' } });
      process.stdout.write('payout_id,user_id,identity_ref,country,amount_cents,currency\n');
      for (const r of rows) process.stdout.write(`${r.id},${r.userId},${r.identityRef},${r.country},${r.amountCents},${s.currency}\n`);
      return;
    }
    case 'paid': {
      const [providerRef, ...ids] = args;
      if (!providerRef || ids.length === 0) throw new Error('usage: paid <providerRef> <payoutId> [payoutId...]');
      return out({ paid: await markPaid(ids, providerRef) });
    }
    case 'rollover':
      return out({ rolloverCents: await rolloverCents(args[0]!) });
    case 'boards-rebuild':
      return out({ players: await rebuildLeaderboards() });
    default:
      throw new Error('usage: season <preview|review|award|verify|export|paid|rollover|boards-rebuild> ...');
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });
