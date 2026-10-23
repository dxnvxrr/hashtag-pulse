/**
 * Daily streak with Anchors — the server copy of Web/progress.js (test/social.test.ts keeps them identical).
 * Every 7th day in a row earns an Anchor (max 2); an Anchor covers one missed day.
 */
export const ANCHOR_EVERY_DAYS = 7;
export const MAX_ANCHORS = 2;

export interface StreakState {
  last: string | null;
  streak: number;
  best: number;
  anchors: number;
  played: string[];
}

export type StreakEvent = 'same-day' | 'continued' | 'anchored' | 'first' | 'reset';

export interface StreakResult {
  state: StreakState;
  event: StreakEvent;
  anchorsUsed: number;
  anchorEarned: boolean;
}

/** The calendar day (YYYY-MM-DD) in a time zone; UTC when the zone is missing or unknown. */
export function dayKeyIn(timeZone: string | null | undefined, date: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function daysBetween(a: string, b: string): number {
  const utc = (k: string) => {
    const [y, m, d] = k.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(b) - utc(a)) / 86_400_000);
}

export function emptyStreak(): StreakState {
  return { last: null, streak: 0, best: 0, anchors: 0, played: [] };
}

export function recordPlay(state: StreakState, today: string): StreakResult {
  const s: StreakState = { ...state, played: [...state.played] };
  const result: StreakResult = { state: s, event: 'same-day', anchorsUsed: 0, anchorEarned: false };
  const gap = s.last === null ? Infinity : daysBetween(s.last, today);
  // Same day, or a day key that moved backwards (time-zone change, clock fix): nothing to record.
  if (gap <= 0) return result;

  if (gap === 1) {
    s.streak += 1;
    result.event = 'continued';
  } else if (gap > 1 && gap - 1 <= s.anchors) {
    s.anchors -= gap - 1;
    result.anchorsUsed = gap - 1;
    s.streak += 1;
    result.event = 'anchored';
  } else {
    result.event = s.last === null ? 'first' : 'reset';
    s.streak = 1;
  }
  if (s.streak % ANCHOR_EVERY_DAYS === 0 && s.anchors < MAX_ANCHORS) {
    s.anchors += 1;
    result.anchorEarned = true;
  }
  s.last = today;
  s.best = Math.max(s.best, s.streak);
  s.played = [...s.played.filter((d) => daysBetween(d, today) < 14), today];
  return result;
}
