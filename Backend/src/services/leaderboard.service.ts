import type { Region } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { redis, RedisKeys } from '../lib/redis.js';
import { ensureDisplayName } from './profile.service.js';

/**
 * Global and regional leaderboards. Redis sorted sets give O(log n) rank lookups; Postgres stays the source of
 * truth, and rebuildLeaderboards() recreates every set from it (on first start, or after Redis loses data).
 *
 * Boards (all from server-verified Ranked runs; Slow-Mo rings never count):
 *  - season:    points this calendar month (UTC)
 *  - lifetime:  points ever
 *  - prestige:  Prestige level, ties broken by lifetime points
 *  - precision: Precision rating, ties broken by lifetime points
 * Points are half-points (PERFECT 4, CLEAN 3, CLOSE 2), shown halved, like the Prestige circle.
 */

export const BOARDS = ['season', 'lifetime', 'prestige', 'precision'] as const;
export type Board = (typeof BOARDS)[number];
export const REGIONS: readonly Region[] = ['NA', 'SA', 'EU', 'AF', 'ME', 'AS', 'OC'];
export type Scope = Region | 'GLOBAL';

/** Composite scores stay below 2^53: level/rating x 1e12 + half-points (< 1e12). */
const TIE = 1e12;
const SEASON_KEY_TTL_SEC = 120 * 24 * 60 * 60;

export function seasonId(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function seasonBounds(id: string): { start: Date; end: Date } {
  const [y, m] = id.split('-').map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

export function halfPoints(c: { perfects: number; cleans: number; closes: number }): number {
  return c.perfects * 4 + c.cleans * 3 + c.closes * 2;
}

function key(board: Board, scope: Scope, season: string): string {
  return board === 'season' ? RedisKeys.board(`season:${season}`, scope) : RedisKeys.board(board, scope);
}

function scopes(region: Region | null): Scope[] {
  return region ? ['GLOBAL', region] : ['GLOBAL'];
}

interface Standing {
  lifetimeHalf: number;
  prestige: number;
  rating: number;
}

function scoresFor(s: Standing): Record<Exclude<Board, 'season'>, number> {
  const half = Math.min(s.lifetimeHalf, TIE - 1);
  return { lifetime: half, prestige: s.prestige * TIE + half, precision: s.rating * TIE + half };
}

/** After a verified Ranked run: refresh the player's standing and add the run's points to the season. */
export async function recordRankedRun(userId: string, region: Region | null, standing: Standing, runHalf: number, at: Date): Promise<void> {
  const scores = scoresFor(standing);
  const season = seasonId(at);
  const m = redis.multi();
  for (const scope of scopes(region)) {
    for (const board of ['lifetime', 'prestige', 'precision'] as const) m.zadd(key(board, scope, season), scores[board], userId);
    const sk = key('season', scope, season);
    m.zincrby(sk, runHalf, userId);
    m.expire(sk, SEASON_KEY_TTL_SEC);
  }
  await m.exec();
}

/** Moves a player's entries to a new region (or out of all regions). */
export async function moveRegion(userId: string, from: Region | null, to: Region | null, at: Date): Promise<void> {
  if (from === to) return;
  const season = seasonId(at);
  const boards = BOARDS.map((b) => ({ b, global: key(b, 'GLOBAL', season) }));
  const current = await Promise.all(boards.map(({ global }) => redis.zscore(global, userId)));
  const m = redis.multi();
  boards.forEach(({ b }, i) => {
    if (from) m.zrem(key(b, from, season), userId);
    const score = current[i];
    if (to && score !== null) m.zadd(key(b, to, season), Number(score), userId);
    if (to && b === 'season') m.expire(key(b, to, season), SEASON_KEY_TTL_SEC);
  });
  await m.exec();
}

export interface BoardEntry {
  rank: number;
  name: string;
  region: Region | null;
  /** season/lifetime: half-points; prestige: level; precision: rating. */
  value: number;
  /** Lifetime half-points for prestige and precision (the tie-breaker); same as value otherwise. */
  points: number;
  isMe: boolean;
}

function decode(board: Board, score: number): { value: number; points: number } {
  if (board === 'season' || board === 'lifetime') return { value: score, points: score };
  const value = Math.floor(score / TIE);
  return { value, points: score - value * TIE };
}

/** Top `limit` entries, plus the caller's own rank. Tied scores share a rank. */
export async function readBoard(userId: string, board: Board, scope: Scope, limit: number, now = new Date()) {
  const season = seasonId(now);
  const k = key(board, scope, season);
  const [raw, total, myScore] = await Promise.all([redis.zrevrange(k, 0, limit - 1, 'WITHSCORES'), redis.zcard(k), redis.zscore(k, userId)]);

  const ids: string[] = [];
  const scores: number[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    ids.push(raw[i]!);
    scores.push(Number(raw[i + 1]));
  }
  const users = await prisma.user.findMany({ where: { id: { in: [...ids, userId] } }, select: { id: true, displayName: true, region: true } });
  // Players from before generated names (or who never opened their profile) get one now.
  await Promise.all(users.filter((u) => !u.displayName).map(async (u) => (u.displayName = await ensureDisplayName(u.id, null))));
  const byId = new Map(users.map((u) => [u.id, u]));

  const entries: BoardEntry[] = [];
  let rank = 0;
  scores.forEach((score, i) => {
    if (i === 0 || score !== scores[i - 1]) rank = i + 1;
    const u = byId.get(ids[i]!);
    entries.push({ rank, name: u?.displayName ?? 'Player', region: u?.region ?? null, ...decode(board, score), isMe: ids[i] === userId });
  });

  let me: BoardEntry | null = null;
  if (myScore !== null) {
    const score = Number(myScore);
    const above = await redis.zcount(k, `(${score}`, '+inf');
    const u = byId.get(userId);
    me = { rank: above + 1, name: u?.displayName ?? 'Player', region: u?.region ?? null, ...decode(board, score), isMe: true };
  }
  return { board, region: scope, season, seasonEndsAt: seasonBounds(season).end.toISOString(), total, entries, me };
}

/** Recreates every board from Postgres. Safe to run any time (it rebuilds into fresh keys, then swaps them in). */
export async function rebuildLeaderboards(now = new Date()): Promise<number> {
  const season = seasonId(now);
  const { start, end } = seasonBounds(season);
  const allScopes: Scope[] = ['GLOBAL', ...REGIONS];
  const tmp = (k: string) => `${k}:rebuild`;
  const finalKeys = BOARDS.flatMap((b) => allScopes.map((s) => key(b, s, season)));
  await redis.del(...finalKeys.map(tmp));

  let players = 0;
  let after: string | undefined;
  for (;;) {
    const rows = await prisma.playerStats.findMany({
      where: { rankedRuns: { gt: 0 }, user: { status: 'ACTIVE' }, ...(after ? { userId: { gt: after } } : {}) },
      orderBy: { userId: 'asc' },
      take: 2000,
      select: { userId: true, perfects: true, cleans: true, closes: true, user: { select: { region: true, prestige: true, precisionRating: true } } },
    });
    if (rows.length === 0) break;
    const m = redis.multi();
    for (const r of rows) {
      const scores = scoresFor({ lifetimeHalf: halfPoints(r), prestige: r.user.prestige, rating: r.user.precisionRating });
      for (const scope of scopes(r.user.region)) {
        for (const board of ['lifetime', 'prestige', 'precision'] as const) m.zadd(tmp(key(board, scope, season)), scores[board], r.userId);
      }
    }
    await m.exec();
    players += rows.length;
    after = rows[rows.length - 1]!.userId;
  }

  const seasonRows = await prisma.$queryRaw<Array<{ userId: string; region: Region | null; half: bigint }>>`
    SELECT r."userId", u."region", SUM(r."statPerfects" * 4 + r."statCleans" * 3 + r."statCloses" * 2)::bigint AS half
    FROM "runs" r JOIN "users" u ON u."id" = r."userId"
    WHERE r."mode" = 'RANKED' AND r."status" = 'VALIDATED' AND u."status" = 'ACTIVE'
      AND r."submittedAt" >= ${start} AND r."submittedAt" < ${end}
    GROUP BY r."userId", u."region"`;
  for (let i = 0; i < seasonRows.length; i += 2000) {
    const m = redis.multi();
    for (const r of seasonRows.slice(i, i + 2000)) {
      for (const scope of scopes(r.region)) m.zadd(tmp(key('season', scope, season)), Number(r.half), r.userId);
    }
    await m.exec();
  }

  // Swap in: RENAME is atomic per key; an empty rebuild key means the board is empty, so delete the old one.
  const m = redis.multi();
  for (const k of finalKeys) m.exists(tmp(k));
  const exists = (await m.exec())?.map(([, v]) => v === 1) ?? [];
  const swap = redis.multi();
  finalKeys.forEach((k, i) => (exists[i] ? swap.rename(tmp(k), k) : swap.del(k)));
  for (const scope of allScopes) swap.expire(key('season', scope, season), SEASON_KEY_TTL_SEC);
  swap.set(RedisKeys.boardsBuilt(), new Date().toISOString());
  await swap.exec();
  return players;
}

const REBUILD_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Rebuilds when Redis has no boards (fresh deploy, Redis data lost) or they were built over 6 hours ago, which also
 * heals any update a Redis hiccup dropped. Call under the job lock, so two rebuilds never overlap.
 */
export async function ensureLeaderboards(): Promise<number> {
  const built = await redis.get(RedisKeys.boardsBuilt());
  if (built && Date.now() - Date.parse(built) < REBUILD_EVERY_MS) return 0;
  return rebuildLeaderboards();
}
