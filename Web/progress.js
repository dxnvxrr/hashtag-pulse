// Daily streak with Anchors, and challenge links. Pure functions: the caller owns storage and the clock.

// ---------------------------------------------------------------- Daily streak

export const ANCHOR_EVERY_DAYS = 7;
export const MAX_ANCHORS = 2;

/** Local calendar day as YYYY-MM-DD (the streak follows the player's own midnight). */
export function dayKey(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Whole calendar days from day key `a` to `b` (DST-safe: compares UTC midnights). */
export function daysBetween(a, b) {
  const utc = (k) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(b) - utc(a)) / 86_400_000);
}

export function emptyStreak() {
  return { last: null, streak: 0, best: 0, anchors: 0, played: [] };
}

/**
 * Records a Ranked run on `today`. A gap of one day continues the streak. A longer gap is bridged by spending one
 * Anchor per missed day if the player has enough; otherwise the streak restarts. Every 7th day in a row earns an
 * Anchor (max 2). Returns the new state and what happened, for the results screen.
 */
export function recordPlay(state, today) {
  const s = { ...emptyStreak(), ...state, played: [...(state?.played ?? [])] };
  const result = { state: s, event: 'same-day', anchorsUsed: 0, anchorEarned: false };
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

/** Title-screen status: 'done' today, 'due' (play today to keep it), 'anchored' (Anchors will cover it), 'lost', 'none'. */
export function streakStatus(state, today) {
  if (!state?.last) return 'none';
  const gap = daysBetween(state.last, today);
  if (gap <= 0) return 'done';
  if (gap === 1) return 'due';
  return gap - 1 <= state.anchors ? 'anchored' : 'lost';
}

// ---------------------------------------------------------------- Challenge links
// Format: c-<seed>-<baseMs>-<ringBlock>-<hits>-<avgDeltaUs>[-<runId as 32 hex>]. Only letters, digits and '-', so it
// survives any share path (artifact links keep plain #anchors only). The run id lets the server replay the exact
// run and supply the challenger's verified score; links without it still work.

export function encodeChallenge(c) {
  const base = `c-${c.seed}-${c.base}-${c.block}-${c.hits}-${c.avgUs}`;
  return c.runId ? `${base}-${c.runId.replace(/-/g, '')}` : base;
}

/** Returns null for anything that isn't a well-formed challenge. */
export function decodeChallenge(text) {
  const m = /^#?c-(\d{1,10})-(\d{3,4})-(\d{1,2})-(\d{1,3})-(\d{1,6})(?:-([0-9a-f]{32}))?(?:-|$)/.exec(text ?? '');
  if (!m) return null;
  const [seed, base, block, hits, avgUs] = m.slice(1, 6).map(Number);
  if (seed > 0xffffffff || base < 800 || base > 2500 || block > 10) return null;
  const h = m[6];
  const runId = h ? `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` : null;
  return { seed, base, block, hits, avgUs, runId };
}

/** Challenge result: more hits wins; equal hits, the lower average delta wins. */
export function compareChallenge(mine, theirs) {
  if (mine.hits !== theirs.hits) return mine.hits > theirs.hits ? 'win' : 'lose';
  if (mine.avgUs === theirs.avgUs) return 'tie';
  return mine.avgUs < theirs.avgUs ? 'win' : 'lose';
}
