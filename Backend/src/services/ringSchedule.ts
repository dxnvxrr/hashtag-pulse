/**
 * Deterministic ring schedule. MUST stay bit-identical to Client/Assets/Scripts/Core/RingSchedule.cs.
 * All arithmetic is uint32 / integer milliseconds so JS and C# cannot diverge on floating point.
 */

export enum RingArchetype {
  Standard = 0,
  Drifter = 1,
}

export interface RingParams {
  durationMs: number;
  /** Gap between the previous ring resolving and this ring spawning (0 for ring 0). */
  gapMs: number;
  archetype: RingArchetype;
  /** -1 left, 0 none, +1 right (visual only for Drifter). */
  drift: -1 | 0 | 1;
}

export const ScheduleConstants = {
  minDurationMs: 800,
  maxDurationMs: 2_500,
  decayPerRingMs: 12,
  decayCapRings: 40,
  jitterMs: 150,
  gapMinMs: 300,
  gapMaxMs: 550,
  standardOnlyRings: 5,
} as const;

export class Mulberry32 {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextUint(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Inclusive range. Draws exactly one value. */
  nextRange(min: number, maxInclusive: number): number {
    const span = maxInclusive - min + 1;
    return min + (this.nextUint() % span);
  }
}

/** Base ring duration from precision rating (0–3000): 2500 ms for novices down to 1300 ms at the top. */
export function baseDurationForRating(rating: number): number {
  const r = Math.max(0, Math.min(3000, Math.trunc(rating)));
  return 2_500 - Math.trunc((r * 1_200) / 3_000);
}

export function generateRing(rng: Mulberry32, index: number, baseDurationMs: number): RingParams {
  const c = ScheduleConstants;
  // Always draw exactly four values per ring, in this order, regardless of branch.
  const jitter = rng.nextRange(-c.jitterMs, c.jitterMs);
  const gap = rng.nextRange(c.gapMinMs, c.gapMaxMs);
  const archetypeRoll = rng.nextUint() % 4;
  const driftRoll = rng.nextUint() % 2;

  const decay = Math.min(index, c.decayCapRings) * c.decayPerRingMs;
  const durationMs = Math.max(c.minDurationMs, Math.min(c.maxDurationMs, baseDurationMs - decay + jitter));
  const archetype = index >= c.standardOnlyRings && archetypeRoll === 0 ? RingArchetype.Drifter : RingArchetype.Standard;
  const drift: -1 | 0 | 1 = archetype === RingArchetype.Drifter ? (driftRoll === 0 ? -1 : 1) : 0;

  return { durationMs, gapMs: index === 0 ? 0 : gap, archetype, drift };
}

export function generateSchedule(seed: number, baseDurationMs: number, count: number): RingParams[] {
  const rng = new Mulberry32(seed);
  const rings: RingParams[] = new Array(count);
  for (let i = 0; i < count; i++) rings[i] = generateRing(rng, i, baseDurationMs);
  return rings;
}
