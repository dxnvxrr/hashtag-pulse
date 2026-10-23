import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { cancelSnapshot, createSnapshot, eligibleEntries, exclusionSummary, finalizeSnapshot } from '../services/airdrop.service.js';

/**
 * Operator CLI for airdrop snapshots (no HTTP surface on purpose). From Backend/ after `npm run build`:
 *
 *   npm run airdrop -- snapshot <label> <cutoff ISO time> [minRankedRuns] [perfect clean close]
 *   npm run airdrop -- show <label>
 *   npm run airdrop -- finalize <label>      freezes it and records the digest
 *   npm run airdrop -- cancel <label>
 *   npm run airdrop -- export <label> > snapshot.csv
 */
const [cmd, label, ...rest] = process.argv.slice(2);

async function show(l: string) {
  const s = await prisma.airdropSnapshot.findUniqueOrThrow({ where: { label: l } });
  const reasons = await exclusionSummary(s.id);
  console.error(
    JSON.stringify(
      {
        ...s,
        totalPoints: s.totalPoints.toString(),
        players: Object.fromEntries(reasons.map((r) => [r.excludedReason ?? 'eligible', r._count])),
      },
      null,
      2,
    ),
  );
}

async function main() {
  if (!label) throw new Error('usage: airdrop <snapshot|show|finalize|cancel|export> <label> ...');
  switch (cmd) {
    case 'snapshot': {
      const [cutoff, minRuns, ...weights] = rest;
      const cutoffAt = new Date(cutoff ?? '');
      if (Number.isNaN(cutoffAt.getTime())) throw new Error('cutoff must be an ISO time, e.g. 2027-01-01T00:00:00Z');
      const [perfect, clean, close] = weights.map(Number);
      await createSnapshot({
        label,
        cutoffAt,
        ...(minRuns !== undefined ? { minRankedRuns: Number(minRuns) } : {}),
        ...(weights.length === 3 ? { weights: { perfect: perfect!, clean: clean!, close: close! } } : {}),
      });
      return show(label);
    }
    case 'show':
      return show(label);
    case 'finalize':
      await finalizeSnapshot(label);
      return show(label);
    case 'cancel':
      await cancelSnapshot(label);
      return show(label);
    case 'export': {
      const s = await prisma.airdropSnapshot.findUniqueOrThrow({ where: { label } });
      process.stdout.write('user_id,points\n');
      for await (const e of eligibleEntries(s.id)) process.stdout.write(`${e.userId},${e.points}\n`);
      return;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
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
