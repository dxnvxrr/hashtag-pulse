import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';
// @ts-expect-error — plain JS modules shared with the browser client
const social = await import('../../Web/social.js');
// @ts-expect-error — plain JS module shared with the browser client
const progress = await import('../../Web/progress.js');
const streak = await import('../src/services/streak.js');
const profile = await import('../src/services/profile.service.js');
const board = await import('../src/services/leaderboard.service.js');
const { ageFlags } = await import('../src/services/auth.service.js');
const { compareScores } = await import('../src/services/challenge.service.js');
const { challengeScore } = await import('../src/services/stats.service.js');

test('server and web share the name lists, regions and points', () => {
  assert.deepEqual(profile.NAME_ADJECTIVES, social.NAME_ADJECTIVES);
  assert.deepEqual(profile.NAME_NOUNS, social.NAME_NOUNS);
  assert.equal(profile.makeHandle(5, 9, 4321), social.makeHandle(5, 9, 4321));
  assert.match(profile.randomHandle(), social.HANDLE_PATTERN);
  assert.deepEqual([...board.REGIONS], social.REGION_CODES);
  const c = { perfects: 3, cleans: 2, closes: 1 };
  assert.equal(board.halfPoints(c), social.halfPoints(c));
  assert.equal(social.fmtPoints(25), '12.5');
  assert.equal(social.fmtPoints(2468), '1,234');
  assert.equal(board.seasonId(new Date('2026-10-31T23:59:59Z')), social.seasonId(new Date('2026-10-31T23:59:59Z')));
  assert.equal(board.seasonBounds('2026-12').end.toISOString(), '2027-01-01T00:00:00.000Z');
});

test('region from time zone', () => {
  const cases: Array<[string, string | null]> = [
    ['America/New_York', 'NA'], ['America/Mexico_City', 'NA'], ['America/Sao_Paulo', 'SA'], ['America/Argentina/Buenos_Aires', 'SA'],
    ['Europe/London', 'EU'], ['Africa/Lagos', 'AF'], ['Asia/Dubai', 'ME'], ['Asia/Tokyo', 'AS'], ['Asia/Kolkata', 'AS'],
    ['Australia/Sydney', 'OC'], ['Pacific/Auckland', 'OC'], ['Pacific/Honolulu', 'NA'], ['Indian/Mauritius', 'AF'],
    ['Atlantic/Reykjavik', 'EU'], ['Asia/Nicosia', 'EU'], ['UTC', null], ['Antarctica/Troll', null], [undefined as unknown as string, null],
  ];
  for (const [tz, want] of cases) assert.equal(social.regionForTimeZone(tz), want, tz);
});

test('server streak matches the web streak over a random play history', () => {
  let web = progress.emptyStreak();
  let srv = streak.emptyStreak();
  let day = Date.UTC(2026, 0, 1);
  let seed = 7;
  for (let i = 0; i < 400; i++) {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    day += [0, 86_400_000, 86_400_000, 2 * 86_400_000, 3 * 86_400_000, 5 * 86_400_000, -86_400_000][seed % 7]!;
    const key = new Date(day).toISOString().slice(0, 10);
    const a = progress.recordPlay(web, key);
    const b = streak.recordPlay(srv, key);
    assert.deepEqual(b, a, `step ${i} (${key})`);
    web = a.state;
    srv = b.state;
  }
});

test('a day key that moves backwards never resets the streak', () => {
  const s = { last: '2026-10-10', streak: 9, best: 9, anchors: 1, played: [] };
  assert.equal(streak.recordPlay(s, '2026-10-09').event, 'same-day');
  assert.equal(progress.recordPlay(s, '2026-10-09').state.streak, 9);
  assert.equal(progress.streakStatus(s, '2026-10-09'), 'done');
});

test('streak days follow the player time zone', () => {
  const t = new Date('2026-10-23T02:00:00Z');
  assert.equal(streak.dayKeyIn('America/Los_Angeles', t), '2026-10-22');
  assert.equal(streak.dayKeyIn('Asia/Tokyo', t), '2026-10-23');
  assert.equal(streak.dayKeyIn('Not/AZone', t), '2026-10-23');
  assert.equal(streak.isTimeZone('Europe/Paris'), true);
  assert.equal(streak.isTimeZone('Mars/Base'), false);
});

test('age gate flags are conservative', () => {
  const now = new Date('2026-10-23T00:00:00Z');
  assert.deepEqual(ageFlags(2013, now), { isMinor: true, isAdult: false }); // could still be 12
  assert.deepEqual(ageFlags(2012, now), { isMinor: false, isAdult: false });
  assert.deepEqual(ageFlags(2008, now), { isMinor: false, isAdult: true }); // ID check settles 17 vs 18
  assert.deepEqual(ageFlags(1980, now), { isMinor: false, isAdult: true });
});

test('challenge score and comparison match the web client', () => {
  const R = (verdict: string, deltaUs: number | null) => ({ verdict, deltaUs, slow: false }) as never;
  const rings = [R('PERFECT', 1000), R('MISS', null), R('CLEAN', -9000), R('MISS', null), R('MISS', null), R('MISS', null), R('MISS', null), R('PERFECT', 0)];
  // The ring after the 5th miss is outside the challenge window.
  assert.deepEqual(challengeScore(rings), { hits: 2, avgUs: 5000 });
  for (const [m, t] of [[{ hits: 3, avgUs: 9 }, { hits: 2, avgUs: 1 }], [{ hits: 2, avgUs: 5 }, { hits: 2, avgUs: 5 }], [{ hits: 2, avgUs: 9 }, { hits: 2, avgUs: 1 }]]) {
    assert.equal(compareScores(m!, t!), progress.compareChallenge(m, t));
  }
});
