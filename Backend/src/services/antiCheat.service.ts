import { createHmac } from 'node:crypto';
import type { RunMode } from '@prisma/client';
import { config, GameRules } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { redis, RedisKeys } from '../lib/redis.js';
import { hmacSha256Base64, randomUint32, safeEqual, sha256Hex } from '../lib/crypto.js';
import { Errors } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { getSession } from './auth.service.js';
import { baseDurationForRating, generateSchedule } from './ringSchedule.js';
import { applyPrestige, nextRating, toGameTimeUs, windowRealUs, type RingOutcome } from './progression.js';
import { applyLedgerEntries, toWalletView, type LedgerEntry, type WalletView } from './wallet.service.js';
import { addRankedRun, statCounts, type LifetimeStats } from './stats.service.js';

// ============================================================ Request signing

export interface SignedRequestParts {
  method: string;
  /** Path + query exactly as sent, e.g. `/v1/runs/submit`. */
  path: string;
  timestampMs: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
  sessionId: string;
  rawBody: string;
}

/**
 * Canonical string (must match NetworkManager.cs):
 *   METHOD \n PATH \n TIMESTAMP_MS \n NONCE \n hex(SHA256(body))
 * Signed with the per-session key issued at login. Protects integrity + replay; it is NOT a
 * substitute for server-side validation, because the key necessarily lives in client memory.
 */
export function canonicalString(method: string, path: string, timestampMs: string, nonce: string, rawBody: string): string {
  return `${method.toUpperCase()}\n${path}\n${timestampMs}\n${nonce}\n${sha256Hex(rawBody)}`;
}

export async function verifyRequestSignature(p: SignedRequestParts): Promise<void> {
  if (!p.timestampMs || !p.nonce || !p.signature) throw Errors.unauthorized('missing_signature');
  if (!/^\d{13}$/.test(p.timestampMs)) throw Errors.unauthorized('bad_timestamp');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(p.nonce)) throw Errors.unauthorized('bad_nonce');

  const skew = Math.abs(Date.now() - Number(p.timestampMs));
  if (skew > GameRules.signatureMaxSkewMs) throw Errors.unauthorized('timestamp_out_of_window');

  const session = await getSession(p.sessionId);
  if (!session) throw Errors.unauthorized('session_expired');

  const expected = hmacSha256Base64(Buffer.from(session.key, 'base64url'), canonicalString(p.method, p.path, p.timestampMs, p.nonce, p.rawBody));
  if (!safeEqual(expected, p.signature)) throw Errors.unauthorized('bad_signature');

  // Nonce is consumed only after the signature checks out, so garbage can't fill the nonce space.
  const fresh = await redis.set(RedisKeys.nonce(p.sessionId, p.nonce), '1', 'EX', GameRules.nonceTtlSec, 'NX');
  if (fresh !== 'OK') throw Errors.unauthorized('replayed_nonce');
}

// ============================================================ Run lifecycle

export type { Verdict } from './progression.js';
import type { Verdict } from './progression.js';

export interface RunStartResult {
  runId: string;
  seed: number;
  mode: RunMode;
  baseDurationMs: number;
  ftue: boolean;
  maxRings: number;
  maxMisses: number;
  /** Server epoch ms at which ring 0 spawns. */
  ring0ServerTimeMs: number;
  serverTimeMs: number;
  verdictWindowsMs: { perfect: number; clean: number; close: number; ftueClose: number };
}

const FTUE_CLOSE_WINDOW_MS = 60;
const GAUNTLET_RINGS = 25;
const FIXED_BASE_DURATION_MS = 1_900;
const SUBMIT_GRACE_MS = 15_000;

/** Lives per mode. Ranked: 5. Zen: effectively unlimited. Legacy Pulse/Gauntlet/Duel (Unity build): 3. */
/** Lives a server-verified ad gives back. Ranked refills all 5; the legacy Unity modes give +1. */
export function refillFor(mode: RunMode): number {
  return mode === 'RANKED' ? GameRules.rankedLives : 1;
}

export function livesFor(mode: RunMode): number {
  if (mode === 'ZEN') return GameRules.runMaxRings;
  if (mode === 'RANKED' || mode === 'DUEL') return GameRules.rankedLives;
  return GameRules.maxMisses;
}

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Everyone gets the same Gauntlet seed per UTC day, and nobody can predict tomorrow's. */
export function gauntletSeed(day = utcDay()): number {
  return createHmac('sha256', config.JWT_ACCESS_SECRET).update(`gauntlet:${day}`).digest().readUInt32LE(0);
}

/** `duelSeed`/`duelBaseMs`: a challenge replays the friend's exact rings (their seed and ring speed). */
export async function startRun(userId: string, mode: RunMode, duelSeed?: number, duelBaseMs?: number): Promise<RunStartResult> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { precisionRating: true, bestDeltaUs: true, status: true } });
  if (!user) throw Errors.notFound('user_not_found');
  if (user.status !== 'ACTIVE' && user.status !== 'QUARANTINED') throw Errors.forbidden('account_inactive');

  let seed: number;
  let baseDurationMs: number;
  let maxRings: number = GameRules.runMaxRings;
  switch (mode) {
    case 'GAUNTLET':
      seed = gauntletSeed();
      baseDurationMs = FIXED_BASE_DURATION_MS;
      maxRings = GAUNTLET_RINGS;
      break;
    case 'DUEL':
      if (duelSeed === undefined || !Number.isInteger(duelSeed) || duelSeed < 0 || duelSeed > 0xffffffff) {
        throw Errors.badRequest('bad_duel_seed', 'Duel requires a uint32 seed');
      }
      seed = duelSeed;
      baseDurationMs = duelBaseMs ?? FIXED_BASE_DURATION_MS;
      break;
    default:
      seed = randomUint32();
      baseDurationMs = baseDurationForRating(user.precisionRating);
  }
  const ftue = (mode === 'PULSE' || mode === 'RANKED') && user.bestDeltaUs === null;
  if (ftue) baseDurationMs = 2_500;

  const run = await prisma.run.create({ data: { userId, mode, seed: BigInt(seed), baseDurationMs, ftue } });
  const now = Date.now();
  const ring0 = now + GameRules.runLeadInMs;

  await redis
    .multi()
    .hset(RedisKeys.run(run.id), {
      userId,
      mode,
      seed: String(seed),
      baseDurationMs: String(baseDurationMs),
      ftue: ftue ? '1' : '0',
      maxRings: String(maxRings),
      ring0Ms: String(ring0),
      refills: '0',
    })
    .expire(RedisKeys.run(run.id), GameRules.runTtlSec)
    .exec();

  return {
    runId: run.id,
    seed,
    mode,
    baseDurationMs,
    ftue,
    maxRings,
    maxMisses: livesFor(mode),
    ring0ServerTimeMs: ring0,
    serverTimeMs: now,
    verdictWindowsMs: {
      perfect: GameRules.verdict.perfectMs,
      clean: GameRules.verdict.cleanMs,
      close: GameRules.verdict.closeMs,
      ftueClose: FTUE_CLOSE_WINDOW_MS,
    },
  };
}

/** Called by the rewarded-ad flow: records one refill on the active run (worth refillFor(mode) lives). */
export async function grantExtraLife(userId: string, runId: string): Promise<boolean> {
  const key = RedisKeys.run(runId);
  const owner = await redis.hget(key, 'userId');
  if (owner !== userId) return false;
  await redis.hincrby(key, 'refills', 1);
  return true;
}

// ------------------------------------------------------------ Pure evaluation (unit-testable)

export interface EvaluationInput {
  seed: number;
  baseDurationMs: number;
  ftue: boolean;
  maxMisses: number;
  maxRings: number;
  /** Per ring: tap time in µs relative to ring 0 spawn on the client's monotonic clock, or -1 for no tap. */
  tapsUs: number[];
  /** Ring indices on which a Slow-Mo Ticket was consumed. */
  slowMoRings: number[];
  /**
   * Rewarded-ad continues: play paused after ring `afterRing` and resumed at `atUs`. The next ring spawns at
   * max(normal spawn, atUs). At most one per extra life granted by a server-verified ad.
   */
  resumes?: Array<{ afterRing: number; atUs: number }>;
  maxResumes?: number;
}

export interface EvaluationResult {
  valid: boolean;
  rejectReason?: string;
  flags: string[];
  verdicts: Verdict[];
  deltasUs: number[];
  perfects: number;
  cleans: number;
  closes: number;
  misses: number;
  totalDeltaUs: number;
  bestDeltaUs: number | null;
  /** When the final ring resolved, µs after ring 0 spawn — compared with server wall clock. */
  clientEndUs: number;
  /** Per ring, in order: verdict, game-time delta (null if untapped), whether Slow-Mo was used. */
  rings: RingOutcome[];
}

function verdictFor(absDeltaUs: number, closeWindowMs: number): Verdict {
  const v = GameRules.verdict;
  if (absDeltaUs <= v.perfectMs * 1000) return 'PERFECT';
  if (absDeltaUs <= v.cleanMs * 1000) return 'CLEAN';
  if (absDeltaUs <= closeWindowMs * 1000) return 'CLOSE';
  return 'MISS';
}

function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Re-simulates the run from the seed. The server owns the ring timeline; the client only contributes tap
 * times. Rule shared with the client: ring i+1 spawns `gap` ms after ring i resolves (tap, or window expiry).
 */
export function evaluateRun(input: EvaluationInput): EvaluationResult {
  const result: EvaluationResult = {
    valid: true,
    flags: [],
    verdicts: [],
    deltasUs: [],
    perfects: 0,
    cleans: 0,
    closes: 0,
    misses: 0,
    totalDeltaUs: 0,
    bestDeltaUs: null,
    clientEndUs: 0,
    rings: [],
  };
  const reject = (reason: string): EvaluationResult => ({ ...result, valid: false, rejectReason: reason });

  const n = input.tapsUs.length;
  if (n === 0) return reject('empty_run');
  if (n > input.maxRings) return reject('too_many_rings');

  const slowMo = new Set(input.slowMoRings);
  if (slowMo.size !== input.slowMoRings.length) return reject('duplicate_slowmo');
  for (const idx of slowMo) if (!Number.isInteger(idx) || idx < 0 || idx >= n) return reject('bad_slowmo_index');

  const resumes = new Map<number, number>();
  for (const r of input.resumes ?? []) {
    if (!Number.isInteger(r.afterRing) || !Number.isInteger(r.atUs) || r.afterRing < 0 || r.afterRing >= n - 1) return reject('bad_resume');
    if (resumes.has(r.afterRing)) return reject('duplicate_resume');
    resumes.set(r.afterRing, r.atUs);
  }
  if (resumes.size > (input.maxResumes ?? 0)) return reject('resume_without_extra_life');

  const rings = generateSchedule(input.seed, input.baseDurationMs, n);
  const signedDeltasMs: number[] = [];
  let spawnUs = 0;
  let resolveUs = 0;

  for (let i = 0; i < n; i++) {
    const ring = rings[i]!;
    if (i > 0) {
      spawnUs = resolveUs + ring.gapMs * 1000;
      const resumeAt = resumes.get(i - 1);
      if (resumeAt !== undefined) {
        if (resumeAt < resolveUs) return reject('resume_before_resolve');
        spawnUs = Math.max(spawnUs, resumeAt);
      }
    }
    // Slow-Mo = 0.4x time: the ring takes 2.5x as long on the wall clock and is scored in game time,
    // so every verdict window is 2.5x wider in real time.
    const slow = slowMo.has(i);
    const durationUs = slow ? ring.durationMs * 2_500 : ring.durationMs * 1_000;
    const closeUs = spawnUs + durationUs;
    const closeWindowMs = input.ftue && i === 0 ? FTUE_CLOSE_WINDOW_MS : GameRules.verdict.closeMs;
    const deadlineUs = closeUs + windowRealUs(closeWindowMs, slow);
    const tap = input.tapsUs[i]!;

    if (!Number.isInteger(tap)) return reject('non_integer_tap');

    let verdict: Verdict;
    let gameDelta: number | null = null;
    if (tap === -1) {
      verdict = 'MISS';
      resolveUs = deadlineUs;
    } else {
      if (tap < spawnUs) return reject('tap_before_spawn');
      if (tap > deadlineUs) return reject('tap_after_window');
      if (tap - spawnUs < GameRules.humanReactionFloorMs * 1000) result.flags.push(`inhuman_reaction:${i}`);
      gameDelta = toGameTimeUs(tap - closeUs, slow);
      const abs = Math.abs(gameDelta);
      verdict = verdictFor(abs, closeWindowMs);
      result.deltasUs.push(gameDelta);
      signedDeltasMs.push(gameDelta / 1000);
      result.totalDeltaUs += abs;
      // Best tap is a skill record: Slow-Mo rings never count toward it.
      if (!slow && (result.bestDeltaUs === null || abs < result.bestDeltaUs)) result.bestDeltaUs = abs;
      resolveUs = tap;
    }
    result.rings.push({ verdict, deltaUs: gameDelta, slow });

    result.verdicts.push(verdict);
    if (verdict === 'PERFECT') result.perfects++;
    else if (verdict === 'CLEAN') result.cleans++;
    else if (verdict === 'CLOSE') result.closes++;
    else result.misses++;

    // Rings after the final allowed miss can't exist.
    if (result.misses >= input.maxMisses && i < n - 1) return reject('rings_after_game_over');
  }

  result.clientEndUs = resolveUs;

  if (signedDeltasMs.length >= GameRules.botMinSamples && stdDev(signedDeltasMs) < GameRules.botStdDevFloorMs) {
    result.flags.push('inhuman_consistency');
  }
  return result;
}

// ------------------------------------------------------------ Submission

/** Atomically takes up to `rings` boosted rings from the double-ticks balance (two concurrent submits can't both spend it). */
const CONSUME_BOOST_LUA = `
local v = tonumber(redis.call('GET', KEYS[1]) or '0')
local take = math.min(v, tonumber(ARGV[1]))
if take > 0 then redis.call('DECRBY', KEYS[1], take) end
return take`;

async function consumeBoost(userId: string, rings: number): Promise<number> {
  return Number(await redis.eval(CONSUME_BOOST_LUA, 1, `boost:${userId}`, String(rings)));
}

/** Gauntlet ranking: fewer misses first, then lowest total delta. Lower score is better. */
export function gauntletScore(misses: number, totalDeltaUs: number): number {
  return misses * 1e10 + totalDeltaUs;
}

export interface RunSubmitInput {
  runId: string;
  tapsUs: number[];
  slowMoRings: number[];
  resumes?: Array<{ afterRing: number; atUs: number }>;
}

export interface RunSubmitResult {
  runId: string;
  status: 'VALIDATED' | 'QUARANTINED' | 'REJECTED';
  verdicts: Verdict[];
  deltasUs: number[];
  ticksAwarded: number;
  /** -1 when the player has no recorded best yet (Unity JsonUtility cannot deserialise null into a long). */
  newBestDeltaUs: number;
  personalBest: boolean;
  precisionRating: number;
  prestige: number;
  prestigeUnlocked: number[];
  /** Lifetime Ranked totals after this run; null when the run didn't change them. */
  lifetime: LifetimeStats | null;
  wallet: WalletView | null;
  reason?: string;
}

export async function submitRun(userId: string, input: RunSubmitInput, ip: string): Promise<RunSubmitResult> {
  const key = RedisKeys.run(input.runId);
  // Atomic read-and-delete: a run can be submitted exactly once even under concurrent retries.
  const execResult = await redis.multi().hgetall(key).del(key).exec();
  const state = (execResult?.[0]?.[1] ?? {}) as Record<string, string>;
  if (!state.userId) throw Errors.conflict('run_not_active', 'Run expired or already submitted');
  if (state.userId !== userId) throw Errors.forbidden('run_owner_mismatch');

  const mode = state.mode as RunMode;
  const evalInput: EvaluationInput = {
    seed: Number(state.seed),
    baseDurationMs: Number(state.baseDurationMs),
    ftue: state.ftue === '1',
    maxMisses: livesFor(mode) + Number(state.refills ?? 0) * refillFor(mode),
    maxRings: Number(state.maxRings),
    tapsUs: input.tapsUs,
    slowMoRings: input.slowMoRings,
    resumes: input.resumes ?? [],
    maxResumes: Number(state.refills ?? 0),
  };
  const ev = evaluateRun(evalInput);

  // Speed-hack defence: the client's game timeline can't run ahead of real time, and can't lag far behind it.
  if (ev.valid) {
    const serverElapsedMs = Date.now() - Number(state.ring0Ms);
    const clientMs = ev.clientEndUs / 1000;
    if (clientMs > serverElapsedMs * (1 + GameRules.speedHackDriftRatio) + GameRules.speedHackSlackMs) {
      ev.flags.push('clock_ahead_of_server');
    } else if (clientMs < serverElapsedMs * (1 - GameRules.speedHackDriftRatio) - SUBMIT_GRACE_MS) {
      ev.flags.push('clock_behind_server');
    }
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  if (!ev.valid || ev.flags.length > 0) {
    const status = ev.valid ? 'QUARANTINED' : 'REJECTED';
    await prisma.run.update({
      where: { id: input.runId },
      data: {
        status,
        submittedAt: new Date(),
        ringsPlayed: input.tapsUs.length,
        flags: ev.valid ? ev.flags : [ev.rejectReason ?? 'invalid'],
      },
    });
    await audit(`anticheat.run_${status.toLowerCase()}`, {
      userId,
      ip,
      severity: ev.valid ? 'critical' : 'warn',
      metadata: { runId: input.runId, flags: ev.flags, reason: ev.rejectReason ?? null },
    });
    return {
      runId: input.runId,
      status,
      verdicts: ev.verdicts,
      deltasUs: ev.deltasUs,
      ticksAwarded: 0,
      newBestDeltaUs: user.bestDeltaUs ?? -1,
      personalBest: false,
      precisionRating: user.precisionRating,
      prestige: user.prestige,
      prestigeUnlocked: [],
      lifetime: null,
      wallet: null,
      reason: ev.rejectReason ?? 'flagged_for_review',
    };
  }

  // ---- Rewards
  let ticks = 0;
  if (mode !== 'ZEN') {
    const boosted = await consumeBoost(userId, ev.verdicts.length);
    ev.verdicts.forEach((v, i) => {
      const base = v === 'PERFECT' ? GameRules.ticksPerPerfect : v === 'CLEAN' ? GameRules.ticksPerClean : v === 'CLOSE' ? GameRules.ticksPerClose : 0;
      ticks += i < boosted ? base * 2 : base;
    });
    ticks = Math.min(ticks, GameRules.maxTicksPerRun);
  }

  // ---- Precision rating (ELO-like) and Prestige: competitive modes only.
  const competitive = mode === 'PULSE' || mode === 'RANKED';
  const rating = competitive ? nextRating(user.precisionRating, ev.rings) : user.precisionRating;
  const prestige = mode === 'RANKED' ? applyPrestige(user.prestige, ev.verdicts) : { level: user.prestige, unlocked: [] as number[] };

  const personalBest = ev.bestDeltaUs !== null && (user.bestDeltaUs === null || ev.bestDeltaUs < user.bestDeltaUs);
  const newBest = personalBest ? ev.bestDeltaUs : user.bestDeltaUs;

  const entries: LedgerEntry[] = [];
  if (ticks > 0) {
    entries.push({ currency: 'TICKS', amount: BigInt(ticks), reason: 'RUN_REWARD', idempotencyKey: `run:${input.runId}:TICKS`, metadata: { runId: input.runId } });
  }
  if (input.slowMoRings.length > 0) {
    entries.push({
      currency: 'SLOWMO_TICKETS',
      amount: -BigInt(input.slowMoRings.length),
      reason: 'ITEM_PURCHASE',
      idempotencyKey: `run:${input.runId}:SLOWMO`,
      metadata: { runId: input.runId, rings: input.slowMoRings },
    });
  }

  const stats = mode === 'RANKED' ? statCounts(ev.rings) : { perfects: 0, cleans: 0, closes: 0 };

  try {
    const { wallet, lifetime } = await prisma.$transaction(async (tx) => {
      const w = entries.length > 0 ? (await applyLedgerEntries(tx, userId, entries)).wallet : await tx.wallet.findUniqueOrThrow({ where: { userId } });
      await tx.run.update({
        where: { id: input.runId },
        data: {
          status: 'VALIDATED',
          submittedAt: new Date(),
          ringsPlayed: ev.verdicts.length,
          perfects: ev.perfects,
          cleans: ev.cleans,
          closes: ev.closes,
          misses: ev.misses,
          totalDeltaUs: BigInt(ev.totalDeltaUs),
          bestDeltaUs: ev.bestDeltaUs,
          ticksAwarded: ticks,
          statPerfects: stats.perfects,
          statCleans: stats.cleans,
          statCloses: stats.closes,
        },
      });
      await tx.user.update({ where: { id: userId }, data: { precisionRating: rating, bestDeltaUs: newBest, prestige: prestige.level } });
      return { wallet: w, lifetime: mode === 'RANKED' ? await addRankedRun(tx, userId, stats) : null };
    });

    if (mode === 'GAUNTLET') {
      // ZADD LT keeps each player's best attempt of the day.
      const key = RedisKeys.leaderboard('gauntlet', todayKey());
      await redis.zadd(key, 'LT', gauntletScore(ev.misses, ev.totalDeltaUs), userId);
      await redis.expire(key, 8 * 24 * 60 * 60);
    }

    return {
      runId: input.runId,
      status: 'VALIDATED',
      verdicts: ev.verdicts,
      deltasUs: ev.deltasUs,
      ticksAwarded: ticks,
      newBestDeltaUs: newBest ?? -1,
      personalBest,
      precisionRating: rating,
      prestige: prestige.level,
      prestigeUnlocked: prestige.unlocked,
      lifetime,
      wallet: toWalletView(wallet),
    };
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'insufficient_funds') {
      await prisma.run.update({ where: { id: input.runId }, data: { status: 'REJECTED', submittedAt: new Date(), flags: ['slowmo_without_tickets'] } });
      await audit('anticheat.slowmo_without_tickets', { userId, ip, severity: 'warn', metadata: { runId: input.runId } });
      throw Errors.conflict('insufficient_slowmo_tickets', 'Slow-Mo used without tickets');
    }
    throw err;
  }
}

/** Server time for client clock-offset estimation (NTP-style, see NetworkManager.SyncClockAsync). */
export function serverTime(): { serverTimeMs: number } {
  return { serverTimeMs: Date.now() };
}

export interface LeaderboardRow {
  rank: number;
  player: string;
  isYou: boolean;
  misses: number;
  totalDeltaUs: number;
}

function decodeGauntletScore(score: number): { misses: number; totalDeltaUs: number } {
  const misses = Math.floor(score / 1e10);
  return { misses, totalDeltaUs: score - misses * 1e10 };
}

/** Today's Gauntlet: top 10 plus the caller's own rank. Players are shown by a short anonymous tag. */
export async function gauntletLeaderboard(userId: string): Promise<{ day: string; top: LeaderboardRow[]; you: LeaderboardRow | null }> {
  const day = todayKey();
  const key = RedisKeys.leaderboard('gauntlet', day);
  const raw = await redis.zrange(key, 0, 9, 'WITHSCORES');
  const top: LeaderboardRow[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const member = raw[i]!;
    top.push({ rank: i / 2 + 1, player: `Player ${member.slice(0, 4).toUpperCase()}`, isYou: member === userId, ...decodeGauntletScore(Number(raw[i + 1])) });
  }
  const [rank, score] = await Promise.all([redis.zrank(key, userId), redis.zscore(key, userId)]);
  const you = rank === null || score === null ? null : { rank: rank + 1, player: 'You', isYou: true, ...decodeGauntletScore(Number(score)) };
  return { day, top, you };
}

export function todayKey(): string {
  return utcDay();
}
