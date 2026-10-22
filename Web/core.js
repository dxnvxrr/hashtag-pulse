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
export const LIVES = { RANKED: 5, ZEN: Infinity };

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

/** Consecutive hits needed to fill the golden circle that unlocks `level` (1..100). Deeper levels need longer streaks. */
export function prestigeCircleSize(level) {
  return level <= 25 ? 10 : level <= 50 ? 15 : level <= 75 ? 20 : 25;
}

/**
 * Applies a run's verdicts to the player's Prestige. Any non-MISS verdict fills the circle by one; a MISS empties it.
 * A full circle unlocks the next level and starts a fresh circle. Mirrors applyPrestige on the server.
 */
export function applyPrestige(startLevel, verdicts) {
  let level = startLevel;
  let inCircle = 0;
  const unlocked = [];
  for (const v of verdicts) {
    if (v === 'MISS') {
      inCircle = 0;
      continue;
    }
    if (level >= PRESTIGE_MAX) continue;
    inCircle++;
    if (inCircle === prestigeCircleSize(level + 1)) {
      level++;
      unlocked.push(level);
      inCircle = 0;
    }
  }
  return { level, unlocked, inCircle };
}
