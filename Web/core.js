// One More Tap — shared game rules for the web client.
// MUST stay identical to Backend/src/services/ringSchedule.ts + evaluateRun in antiCheat.service.ts
// and Client/Assets/Scripts/Core/RingSchedule.cs. Backend/test/webCore.test.ts enforces parity.

export const ScheduleConstants = {
  minDurationMs: 800,
  maxDurationMs: 2500,
  decayPerRingMs: 12,
  decayCapRings: 40,
  jitterMs: 150,
  gapMinMs: 300,
  gapMaxMs: 550,
  standardOnlyRings: 5,
};

export const Verdicts = { perfectMs: 5, cleanMs: 15, closeMs: 40, ftueCloseMs: 60 };
export const SLOWMO_FACTOR = 2.5;
export const HUMAN_REACTION_FLOOR_MS = 80;

export class Mulberry32 {
  constructor(seed) {
    this.state = seed >>> 0;
  }
  nextUint() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  nextRange(min, maxInclusive) {
    return min + (this.nextUint() % (maxInclusive - min + 1));
  }
}

export function baseDurationForRating(rating) {
  const r = Math.max(0, Math.min(3000, Math.trunc(rating)));
  return 2500 - Math.trunc((r * 1200) / 3000);
}

/** Streaming generator: call next() once per ring, in order. */
export class RingSchedule {
  constructor(seed, baseDurationMs) {
    this.rng = new Mulberry32(seed);
    this.base = baseDurationMs;
    this.index = 0;
  }
  next() {
    const c = ScheduleConstants;
    const jitter = this.rng.nextRange(-c.jitterMs, c.jitterMs);
    const gap = this.rng.nextRange(c.gapMinMs, c.gapMaxMs);
    const archetypeRoll = this.rng.nextUint() % 4;
    const driftRoll = this.rng.nextUint() % 2;
    const i = this.index++;
    const decay = Math.min(i, c.decayCapRings) * c.decayPerRingMs;
    const durationMs = Math.max(c.minDurationMs, Math.min(c.maxDurationMs, this.base - decay + jitter));
    const archetype = i >= c.standardOnlyRings && archetypeRoll === 0 ? 1 : 0;
    const drift = archetype === 1 ? (driftRoll === 0 ? -1 : 1) : 0;
    return { index: i, durationMs, gapMs: i === 0 ? 0 : gap, archetype, drift };
  }
}

export function generateSchedule(seed, baseDurationMs, count) {
  const s = new RingSchedule(seed, baseDurationMs);
  const out = [];
  for (let i = 0; i < count; i++) out.push(s.next());
  return out;
}

export function closeWindowMs(ftue, index) {
  return ftue && index === 0 ? Verdicts.ftueCloseMs : Verdicts.closeMs;
}

/** Scores a game-time |delta| (see toGameTimeUs) against the verdict windows. */
export function classify(absDeltaUs, windowMs) {
  if (absDeltaUs <= Verdicts.perfectMs * 1000) return 'PERFECT';
  if (absDeltaUs <= Verdicts.cleanMs * 1000) return 'CLEAN';
  if (absDeltaUs <= windowMs * 1000) return 'CLOSE';
  return 'MISS';
}

/**
 * Slow-Mo runs a ring at 0.4x, so a real-time delta is converted to game time before scoring (x2/5, truncated
 * toward zero to match C# long division). Every verdict window is therefore 2.5x wider in real time.
 */
export function toGameTimeUs(realDeltaUs, slow) {
  return slow ? Math.trunc((realDeltaUs * 2) / 5) : realDeltaUs;
}

/** Real-time length of a ring's close window. */
export function windowRealUs(windowMs, slow) {
  return slow ? windowMs * 2500 : windowMs * 1000;
}

/** Ticks per verdict (mirrors GameRules.ticksPer* on the server). */
export function ticksFor(verdict) {
  return verdict === 'PERFECT' ? 5 : verdict === 'CLEAN' ? 2 : verdict === 'CLOSE' ? 1 : 0;
}

/** Lives per mode. Ranked: 5. Zen: unlimited. */
export const LIVES = { RANKED: 5, CHALLENGE: 5, ZEN: Infinity };

/**
 * ELO-like rating update (mirrors submitRun on the server). `rings`: [{ verdict, deltaUs (game time, null if untapped), slow }].
 * Slow-Mo rings are left out: a purchasable ticket must never improve the skill number.
 */
export function nextRating(rating, rings) {
  const scored = rings.filter((r) => !r.slow);
  if (scored.length < 5) return rating;
  let sum = 0;
  for (const r of scored) if (r.deltaUs !== null) sum += Math.max(0, 1 - Math.abs(r.deltaUs) / 1000 / Verdicts.closeMs);
  const performance = sum / scored.length;
  return Math.max(0, Math.min(3000, Math.round(rating + 64 * (performance - rating / 3000))));
}

// ---------------------------------------------------------------- Prestige (Ranked only)

export const PRESTIGE_MAX = 100;

/** Size of the golden circle that unlocks `level` (1..100), in points: 10 up to level 25, then 15, 20, 25. */
export function prestigeCircleSize(level) {
  return level <= 25 ? 10 : level <= 50 ? 15 : level <= 75 ? 20 : 25;
}

/** Circle fill per verdict in half-points (integers, so client and server can't drift): PERFECT 2, CLEAN 1.5, CLOSE 1. */
export function prestigeHalfPoints(verdict) {
  return verdict === 'PERFECT' ? 4 : verdict === 'CLEAN' ? 3 : verdict === 'CLOSE' ? 2 : 0;
}

/** Levels X1–X7 of every ten are forgiving: a miss halves the circle. On X8–X10 a miss empties it. */
export function missHalvesCircle(nextLevel) {
  return ((nextLevel - 1) % 10) + 1 <= 7;
}

/**
 * Circle fill (half-points) after a miss while working toward `nextLevel`. Forgiving levels keep half, rounded up to
 * the next half point (8 -> 4, 8.5 -> 4.5, 2 -> 1); anything under 1 point drops to 0.
 */
export function circleAfterMiss(halfPoints, nextLevel) {
  if (!missHalvesCircle(nextLevel)) return 0;
  const kept = Math.ceil(halfPoints / 2);
  return kept < 2 ? 0 : kept;
}

/**
 * Applies a run's verdicts to the player's Prestige. A full circle unlocks the next level permanently; overflow carries
 * into the next circle. Returns the circle fill in points. Mirrors applyPrestige on the server.
 */
export function applyPrestige(startLevel, verdicts) {
  let level = startLevel;
  let half = 0;
  const unlocked = [];
  for (const v of verdicts) {
    if (level >= PRESTIGE_MAX) break;
    if (v === 'MISS') {
      half = circleAfterMiss(half, level + 1);
      continue;
    }
    half += prestigeHalfPoints(v);
    while (level < PRESTIGE_MAX && half >= prestigeCircleSize(level + 1) * 2) {
      half -= prestigeCircleSize(level + 1) * 2;
      level++;
      unlocked.push(level);
    }
  }
  return { level, unlocked, inCircle: level >= PRESTIGE_MAX ? 0 : half / 2 };
}

// ---------------------------------------------------------------- Ring looks (visual only)
// Ring types change how a ring *looks* while it closes, never when it closes, so server scoring is untouched.
// Each Prestige block of ten introduces one: Ghost (10+), Stutter (20+), Eclipse (30+).

export const RING_LOOKS = ['ghost', 'stutter', 'eclipse'];

/** How many special looks the player's block allows (0..3). */
export function looksUnlocked(prestige) {
  return Math.min(RING_LOOKS.length, Math.floor(prestige / 10));
}

/**
 * Look for ring `index` of a run: deterministic in (seed, index, unlocked), so a challenge link shows a friend the
 * exact same rings. Drifters (archetype 1) keep their slide; about 1 in 4 other rings past ring 5 get a special look.
 */
export function ringLook(seed, index, archetype, unlocked) {
  if (archetype === 1) return 'drifter';
  if (unlocked <= 0 || index < 5) return 'standard';
  const r = new Mulberry32((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0).nextUint();
  if (r % 100 >= 25) return 'standard';
  return RING_LOOKS[(r >>> 8) % unlocked];
}

/** Stutter closes in uneven jumps but still lands on the target exactly at the close moment. */
const STUTTER_STEPS = [0, 0.22, 0.38, 0.61, 0.74, 0.9, 1];

/**
 * Visual close progress q (0 = start size, 1 = on the target) at real progress p (1 = the scored close moment).
 * Eclipse touches the target early (a decoy at p = 0.45), opens back up, then truly closes at p = 1.
 */
export function lookProgress(look, p) {
  if (p >= 1 || look === 'standard' || look === 'drifter' || look === 'ghost') return p;
  if (look === 'stutter') {
    let q = 0;
    for (const s of STUTTER_STEPS) if (p >= s) q = s;
    return q;
  }
  if (p < 0.45) return p / 0.45;
  if (p < 0.7) return 1 - 0.45 * ((p - 0.45) / 0.25);
  return 0.55 + 0.45 * ((p - 0.7) / 0.3);
}

/** Ghost fades in and out while closing and is always fully visible for the last 15%. */
export function lookAlpha(look, p) {
  if (look !== 'ghost' || p > 0.85) return 1;
  return 0.12 + 0.88 * (0.5 + 0.5 * Math.cos(p * Math.PI * 4));
}
