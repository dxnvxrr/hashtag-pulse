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

export function classify(absDeltaUs, windowMs) {
  if (absDeltaUs <= Verdicts.perfectMs * 1000) return 'PERFECT';
  if (absDeltaUs <= Verdicts.cleanMs * 1000) return 'CLEAN';
  if (absDeltaUs <= windowMs * 1000) return 'CLOSE';
  return 'MISS';
}

/** Ticks per verdict (mirrors GameRules.ticksPer* on the server). */
export function ticksFor(verdict) {
  return verdict === 'PERFECT' ? 5 : verdict === 'CLEAN' ? 2 : verdict === 'CLOSE' ? 1 : 0;
}

/** ELO-like rating update (mirrors submitRun on the server). */
export function nextRating(rating, verdicts, deltasUs) {
  if (verdicts.length < 5) return rating;
  let sum = 0;
  for (const d of deltasUs) sum += Math.max(0, 1 - Math.abs(d) / 1000 / Verdicts.closeMs);
  const performance = sum / verdicts.length;
  return Math.max(0, Math.min(3000, Math.round(rating + 64 * (performance - rating / 3000))));
}

/** UTC-day seed for the offline Gauntlet (the online one is HMAC'd server-side and unpredictable). */
export function offlineGauntletSeed(day) {
  let h = 2166136261;
  for (const ch of `gauntlet:${day}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
