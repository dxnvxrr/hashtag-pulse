import type { FastifyBaseLogger } from 'fastify';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { GameRules } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { redis, RedisKeys } from '../lib/redis.js';
import { audit } from '../lib/audit.js';

/**
 * Background jobs. They run inside every API replica; a Redis lock makes each pass single-flight across the fleet.
 *  - expireStaleRuns: runs never submitted (app killed, network gone) move ACTIVE -> EXPIRED after the run TTL.
 *  - purgeDeletedAccounts: the 30-day GDPR/CCPA deletion SLA — hard-deletes accounts (cascades to all their rows).
 *  - drainTelemetry: consumer group that moves telemetry from the capped Redis Streams into telemetry_events.
 */

const DELETION_GRACE_DAYS = 30;
const TELEMETRY_GROUP = 'sink';
const TELEMETRY_CATEGORIES = ['ftue', 'difficulty', 'performance', 'transaction', 'ad', 'viral', 'session'] as const;
const TELEMETRY_BATCH = 500;
const CONSUMER = `api-${randomUUID().slice(0, 8)}`;

async function withLock(job: string, ttlSec: number, fn: () => Promise<void>): Promise<boolean> {
  const token = randomUUID();
  const ok = await redis.set(RedisKeys.jobLock(job), token, 'EX', ttlSec, 'NX');
  if (ok !== 'OK') return false;
  try {
    await fn();
  } finally {
    // Release only our own lock (compare-and-delete).
    await redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0", 1, RedisKeys.jobLock(job), token);
  }
  return true;
}

export async function expireStaleRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - GameRules.runTtlSec * 1000);
  const res = await prisma.run.updateMany({ where: { status: 'ACTIVE', startedAt: { lt: cutoff } }, data: { status: 'EXPIRED' } });
  return res.count;
}

export async function purgeDeletedAccounts(): Promise<number> {
  const cutoff = new Date(Date.now() - DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
  const doomed = await prisma.user.findMany({
    where: { status: 'PENDING_DELETION', deletionRequestedAt: { lt: cutoff } },
    select: { id: true },
    take: 500,
  });
  for (const { id } of doomed) {
    await prisma.$transaction([
      // IP addresses are personal data too; the cascade below nulls the user id.
      prisma.auditLog.updateMany({ where: { userId: id }, data: { ip: null } }),
      prisma.user.delete({ where: { id } }),
    ]);
    // The audit row deliberately carries no user id or personal data — only that a purge happened.
    await audit('account.purged', { severity: 'info', metadata: { count: 1 } });
  }
  return doomed.length;
}

type StreamEntry = [id: string, fields: string[]];

function fieldsToObject(fields: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) o[fields[i]!] = fields[i + 1]!;
  return o;
}

async function ensureGroups(): Promise<void> {
  for (const c of TELEMETRY_CATEGORIES) {
    try {
      await redis.xgroup('CREATE', RedisKeys.telemetryStream(c), TELEMETRY_GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
    }
  }
}

async function persist(category: string, entries: StreamEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const rows: Prisma.TelemetryEventCreateManyInput[] = [];
  for (const [id, fields] of entries) {
    const f = fieldsToObject(fields);
    let props: Prisma.InputJsonValue = {};
    try {
      props = JSON.parse(f.props ?? '{}') as Prisma.InputJsonValue;
    } catch {
      props = {};
    }
    if (!f.u || !f.n) continue;
    rows.push({
      streamId: id,
      category,
      name: f.n,
      userId: f.u,
      clientTs: new Date(Number(f.ts) || Date.now()),
      receivedAt: new Date(Number(f.rx) || Date.now()),
      appVersion: f.v ?? '',
      platform: f.p ?? '',
      sessionId: f.s ?? '',
      props,
    });
  }
  // skipDuplicates + the (category, streamId) unique key make redelivery after a crash harmless.
  if (rows.length) await prisma.telemetryEvent.createMany({ data: rows, skipDuplicates: true });
  await redis.xack(RedisKeys.telemetryStream(category), TELEMETRY_GROUP, ...entries.map(([id]) => id));
}

export async function drainTelemetry(): Promise<number> {
  let moved = 0;
  for (const c of TELEMETRY_CATEGORIES) {
    const key = RedisKeys.telemetryStream(c);
    // Reclaim entries another consumer read but never acknowledged (it crashed mid-batch).
    const claimed = (await redis.call('XAUTOCLAIM', key, TELEMETRY_GROUP, CONSUMER, '60000', '0-0', 'COUNT', String(TELEMETRY_BATCH))) as [string, StreamEntry[]];
    if (claimed?.[1]?.length) {
      await persist(c, claimed[1]);
      moved += claimed[1].length;
    }
    const res = (await redis.xreadgroup('GROUP', TELEMETRY_GROUP, CONSUMER, 'COUNT', TELEMETRY_BATCH, 'STREAMS', key, '>')) as
      | Array<[string, StreamEntry[]]>
      | null;
    const entries = res?.[0]?.[1] ?? [];
    await persist(c, entries);
    moved += entries.length;
  }
  return moved;
}

export function startJobs(log: FastifyBaseLogger): () => void {
  const timers: NodeJS.Timeout[] = [];
  const every = (name: string, ms: number, lockSec: number, fn: () => Promise<number>) => {
    const runOnce = () =>
      withLock(name, lockSec, async () => {
        const n = await fn();
        if (n > 0) log.info({ job: name, n }, 'job pass');
      }).catch((err) => log.error({ err, job: name }, 'job failed'));
    const t = setInterval(runOnce, ms);
    t.unref();
    timers.push(t);
    setTimeout(runOnce, 2_000).unref();
  };

  ensureGroups()
    .then(() => every('telemetry-drain', 5_000, 30, drainTelemetry))
    .catch((err) => log.error({ err }, 'telemetry consumer group setup failed'));
  every('expire-runs', 5 * 60_000, 120, expireStaleRuns);
  every('purge-accounts', 60 * 60_000, 600, purgeDeletedAccounts);

  return () => timers.forEach(clearInterval);
}
