import { GameRules } from '../config.js';

/**
 * Scoring and progression rules shared with the web client (Web/core.js) and the Unity client (RunSession.cs).
 * Backend/test/webCore.test.ts and csharpParity.test.ts keep the three in step.
 */

export type Verdict = 'PERFECT' | 'CLEAN' | 'CLOSE' | 'MISS';

/** Slow-Mo runs a ring at 0.4x: real time → game time is x2/5, truncated toward zero (matches C# long division). */
export function toGameTimeUs(realDeltaUs: number, slow: boolean): number {
  return slow ? Math.trunc((realDeltaUs * 2) / 5) : realDeltaUs;
}

/** Real-time length of a ring's close window (2.5x wider on a Slow-Mo ring). */
export function windowRealUs(windowMs: number, slow: boolean): number {
  return slow ? windowMs * 2_500 : windowMs * 1_000;
}

export interface RingOutcome {
  verdict: Verdict;
  /** Game-time delta; null when the ring wasn't tapped. */
  deltaUs: number | null;
  slow: boolean;
}

/** ELO-like update. Slow-Mo rings are excluded: a purchasable ticket must never raise the skill number. */
export function nextRating(rating: number, rings: RingOutcome[]): number {
  const scored = rings.filter((r) => !r.slow);
  if (scored.length < 5) return rating;
  let sum = 0;
  for (const r of scored) if (r.deltaUs !== null) sum += Math.max(0, 1 - Math.abs(r.deltaUs) / 1000 / GameRules.verdict.closeMs);
  const performance = sum / scored.length;
  return Math.max(0, Math.min(3000, Math.round(rating + 64 * (performance - rating / 3000))));
}

export const PRESTIGE_MAX = 100;

/** Size of the golden circle that unlocks `level` (1..100), in points. */
export function prestigeCircleSize(level: number): number {
  return level <= 25 ? 10 : level <= 50 ? 15 : level <= 75 ? 20 : 25;
}

/** PERFECT fills the circle twice as much as any other hit. */
export function prestigePoints(verdict: Verdict): number {
  return verdict === 'PERFECT' ? 2 : verdict === 'MISS' ? 0 : 1;
}

/** Hits fill the circle (PERFECT 2, others 1); a MISS empties it; overflow carries into the next circle. */
export function applyPrestige(startLevel: number, verdicts: Verdict[]): { level: number; unlocked: number[] } {
  let level = startLevel;
  let inCircle = 0;
  const unlocked: number[] = [];
  for (const v of verdicts) {
    if (v === 'MISS') {
      inCircle = 0;
      continue;
    }
    if (level >= PRESTIGE_MAX) continue;
    inCircle += prestigePoints(v);
    while (level < PRESTIGE_MAX && inCircle >= prestigeCircleSize(level + 1)) {
      inCircle -= prestigeCircleSize(level + 1);
      level++;
      unlocked.push(level);
    }
    if (level >= PRESTIGE_MAX) inCircle = 0;
  }
  return { level, unlocked };
}
