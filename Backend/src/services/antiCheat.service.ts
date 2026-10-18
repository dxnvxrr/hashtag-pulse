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
import { applyLedgerEntries, toWalletView, type LedgerEntry, type WalletView } from './wallet.service.js';

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

export type Verdict = 'PERFECT' | 'CLEAN' | 'CLOSE' | 'MISS';

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

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Everyone gets the same Gauntlet seed per UTC day, and nobody can predict tomorrow's. */
export function gauntletSeed(day = utcDay()): number {
  return createHmac('sha256', config.JWT_ACCESS_SECRET).update(`gauntlet:${day}`).digest().readUInt32LE(0);
}

export async function startRun(userId: string, mode: RunMode, duelSeed?: number): Promise<RunStartResult> {
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
      baseDurationMs = FIXED_BASE_DURATION_MS;
      break;
    default:
      seed = randomUint32();
      baseDurationMs = baseDurationForRating(user.precisionRating);
  }
  const ftue = mode === 'PULSE' && user.bestDeltaUs === null;
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
      extraLives: '0',
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
    maxMisses: GameRules.maxMisses,
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

/** Called by the rewarded-ad flow ("Replay this exact ring"): one extra miss allowed on an active run. */
export async function grantExtraLife(userId: string, runId: string): Promise<boolean> {
  const key = RedisKeys.run(runId);
  const owner = await redis.hget(key, 'userId');
  if (owner !== userId) return false;
  await redis.hincrby(key, 'extraLives', 1);
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
  };
  const reject = (reason: string): EvaluationResult => ({ ...result, valid: false, rejectReason: reason });

  const n = input.tapsUs.length;
  if (n === 0) return reject('empty_run');
  if (n > input.maxRings) return reject('too_many_rings');

  const slowMo = new Set(input.slowMoRings);
  if (slowMo.size !== input.slowMoRings.length) return reject('duplicate_slowmo');
  for (const idx of slowMo) if (!Number.isInteger(idx) || idx < 0 || idx >= n) return reject('bad_slowmo_index');

  const rings = generateSchedule(input.seed, input.baseDurationMs, n);
  const signedDeltasMs: number[] = [];
  let spawnUs = 0;
  let resolveUs = 0;

  for (let i = 0; i < n; i++) {
    const ring = rings[i]!;
    if (i > 0) spawnUs = resolveUs + ring.gapMs * 1000;
    // Slow-Mo = 0.4x time → the ring takes 2.5x as long on the wall clock.
    const durationUs = slowMo.has(i) ? ring.durationMs * 2_500 : ring.durationMs * 1_000;
    const closeUs = spawnUs + durationUs;
    const closeWindowMs = input.ftue && i === 0 ? FTUE_CLOSE_WINDOW_MS : GameRules.verdict.closeMs;
    const tap = input.tapsUs[i]!;

    if (!Number.isInteger(tap)) return reject('non_integer_tap');

    let verdict: Verdict;
    if (tap === -1) {
      verdict = 'MISS';
      resolveUs = closeUs + closeWindowMs * 1000;
    } else {
      if (tap < spawnUs) return reject('tap_before_spawn');
      if (tap > closeUs + closeWindowMs * 1000) return reject('tap_after_window');
      if (tap - spawnUs < GameRules.humanReactionFloorMs * 1000) result.flags.push(`inhuman_reaction:${i}`);
      const delta = tap - closeUs;
      const abs = Math.abs(delta);
      verdict = verdictFor(abs, closeWindowMs);
      result.deltasUs.push(delta);
      signedDeltasMs.push(delta / 1000);
      result.totalDeltaUs += abs;
      if (result.bestDeltaUs === null || abs < result.bestDeltaUs) result.bestDeltaUs = abs;
      resolveUs = tap;
    }

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

export interface RunSubmitInput {
  runId: string;
  tapsUs: number[];
  slowMoRings: number[];
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
    maxMisses: GameRules.maxMisses + Number(state.extraLives ?? 0),
    maxRings: Number(state.maxRings),
    tapsUs: input.tapsUs,
    slowMoRings: input.slowMoRings,
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
      wallet: null,
      reason: ev.rejectReason ?? 'flagged_for_review',
    };
  }

  // ---- Rewards
  let ticks = 0;
  if (mode !== 'ZEN') {
    const boostKey = `boost:${userId}`;
    const boostRemaining = Number((await redis.get(boostKey)) ?? 0);
    const boosted = Math.min(boostRemaining, ev.verdicts.length);
    if (boosted > 0) await redis.decrby(boostKey, boosted);
    ev.verdicts.forEach((v, i) => {
      const base = v === 'PERFECT' ? GameRules.ticksPerPerfect : v === 'CLEAN' ? GameRules.ticksPerClean : v === 'CLOSE' ? GameRules.ticksPerClose : 0;
      ticks += i < boosted ? base * 2 : base;
    });
    ticks = Math.min(ticks, GameRules.maxTicksPerRun);
  }

  // ---- Precision rating (ELO-like): performance vs expectation, Pulse only, needs a meaningful sample.
  let rating = user.precisionRating;
  if (mode === 'PULSE' && ev.verdicts.length >= 5) {
    // Untapped rings score 0; tapped rings score linearly from 1 (0 ms) to 0 (close window edge or worse).
    let scoreSum = 0;
    for (const d of ev.deltasUs) scoreSum += Math.max(0, 1 - Math.abs(d) / 1000 / GameRules.verdict.closeMs);
    const performance = scoreSum / ev.verdicts.length;
    const expected = rating / 3000;
    rating = Math.max(0, Math.min(3000, Math.round(rating + 64 * (performance - expected))));
  }

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

  try {
    const wallet = await prisma.$transaction(async (tx) => {
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
        },
      });
      await tx.user.update({ where: { id: userId }, data: { precisionRating: rating, bestDeltaUs: newBest } });
      return w;
    });

    return {
      runId: input.runId,
      status: 'VALIDATED',
      verdicts: ev.verdicts,
      deltasUs: ev.deltasUs,
      ticksAwarded: ticks,
      newBestDeltaUs: newBest ?? -1,
      personalBest,
      precisionRating: rating,
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

export function todayKey(): string {
  return utcDay();
}
