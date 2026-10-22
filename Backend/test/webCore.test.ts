import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-123';
process.env.DEVICE_FINGERPRINT_PEPPER ??= 'test-pepper-test-pepper';

// @ts-expect-error — plain JS module shared with the browser client
const web = await import('../../Web/core.js');
const { generateSchedule, baseDurationForRating } = await import('../src/services/ringSchedule.ts');
const progression = await import('../src/services/progression.ts');
const { evaluateRun } = await import('../src/services/antiCheat.service.ts');

test('web client schedule matches the server for many seeds', () => {
  for (const seed of [0, 1, 12345, 0xffffffff, 2_654_435_761]) {
    for (const base of [800, 1300, 1900, 2500]) {
      const server = generateSchedule(seed, base, 120).map((r) => [r.durationMs, r.gapMs, r.archetype, r.drift]);
      const client = web.generateSchedule(seed, base, 120).map((r: { durationMs: number; gapMs: number; archetype: number; drift: number }) => [r.durationMs, r.gapMs, r.archetype, r.drift]);
      assert.deepEqual(client, server, `seed ${seed} base ${base}`);
    }
  }
  for (const r of [0, 1, 999, 1500, 2999, 3000]) assert.equal(web.baseDurationForRating(r), baseDurationForRating(r));
});

/** Plays a run exactly like Web/game.js does and checks the server agrees on every verdict. */
test('web client verdicts match server re-simulation, including slow-mo and an ad resume', () => {
  const seed = 424242;
  const base = 2000;
  const sched = new web.RingSchedule(seed, base);
  const taps: number[] = [];
  const clientVerdicts: string[] = [];
  const slowMoRings = [2];
  const offsetsMs = [3, -12, 7, 30, -55, 1, -1, 0, 14, -16];
  let resolveUs = 0;
  let resume: { afterRing: number; atUs: number } | null = null;
  for (let i = 0; i < offsetsMs.length; i++) {
    const p = sched.next();
    let spawnUs = i === 0 ? 0 : resolveUs + p.gapMs * 1000;
    if (resume && resume.afterRing === i - 1) spawnUs = Math.max(spawnUs, resume.atUs);
    const durUs = slowMoRings.includes(i) ? p.durationMs * web.SLOWMO_FACTOR * 1000 : p.durationMs * 1000;
    const closeUs = spawnUs + durUs;
    const slow = slowMoRings.includes(i);
    const windowMs = web.closeWindowMs(false, i);
    const off = offsetsMs[i]! * 1000;
    if (Math.abs(off) > web.windowRealUs(windowMs, slow)) {
      taps.push(-1);
      clientVerdicts.push('MISS');
      resolveUs = closeUs + web.windowRealUs(windowMs, slow);
    } else {
      const tap = closeUs + off;
      taps.push(tap);
      clientVerdicts.push(web.classify(Math.abs(web.toGameTimeUs(off, slow)), windowMs));
      resolveUs = tap;
    }
    if (i === 4) resume = { afterRing: 4, atUs: resolveUs + 5_000_000 }; // 5 s ad pause
  }
  const ev = evaluateRun({ seed, baseDurationMs: base, ftue: false, maxMisses: 3, maxRings: 500, tapsUs: taps, slowMoRings, resumes: [resume!], maxResumes: 1 });
  assert.equal(ev.valid, true, ev.rejectReason);
  assert.deepEqual(ev.verdicts, clientVerdicts);
});

test('resume without a granted extra life is rejected', () => {
  const ev = evaluateRun({ seed: 1, baseDurationMs: 2000, ftue: false, maxMisses: 3, maxRings: 500, tapsUs: [-1, -1], slowMoRings: [], resumes: [{ afterRing: 0, atUs: 9_000_000 }], maxResumes: 0 });
  assert.equal(ev.rejectReason, 'resume_without_extra_life');
});

test('slow-mo is scored in game time: 12 ms late on a slow ring is a PERFECT, and it never sets the best tap', () => {
  const ring = generateSchedule(9, 2000, 1)[0]!;
  const tap = ring.durationMs * 2500 + 12_000; // 12 ms real = 4.8 ms game time
  const ev = evaluateRun({ seed: 9, baseDurationMs: 2000, ftue: false, maxMisses: 3, maxRings: 500, tapsUs: [tap], slowMoRings: [0] });
  assert.deepEqual(ev.verdicts, ['PERFECT']);
  assert.equal(ev.deltasUs[0], 4800);
  assert.equal(ev.bestDeltaUs, null);
  assert.equal(web.toGameTimeUs(-12_001, true), progression.toGameTimeUs(-12_001, true));
  // A slow ring stays tappable for 40 ms x 2.5 = 100 ms of real time after it closes: 99 ms late is 39.6 ms of game time.
  const late = evaluateRun({ seed: 9, baseDurationMs: 2000, ftue: false, maxMisses: 3, maxRings: 500, tapsUs: [ring.durationMs * 2500 + 99_000], slowMoRings: [0] });
  assert.deepEqual(late.verdicts, ['CLOSE']);
  const tooLate = evaluateRun({ seed: 9, baseDurationMs: 2000, ftue: false, maxMisses: 3, maxRings: 500, tapsUs: [ring.durationMs * 2500 + 101_000], slowMoRings: [0] });
  assert.equal(tooLate.rejectReason, 'tap_after_window');
});

test('rating ignores slow-mo rings, identically on client and server', () => {
  const rings = [
    { verdict: 'PERFECT', deltaUs: 1000, slow: false },
    { verdict: 'CLEAN', deltaUs: -9000, slow: false },
    { verdict: 'PERFECT', deltaUs: 0, slow: true },
    { verdict: 'CLOSE', deltaUs: 30000, slow: false },
    { verdict: 'MISS', deltaUs: null, slow: false },
    { verdict: 'PERFECT', deltaUs: 2000, slow: false },
    { verdict: 'CLEAN', deltaUs: 7000, slow: false },
  ] as const;
  for (const r of [0, 500, 1000, 2400, 3000]) {
    assert.equal(web.nextRating(r, rings), progression.nextRating(r, rings as never));
  }
  assert.equal(progression.nextRating(1000, rings.slice(0, 4) as never), 1000, 'fewer than 5 non-slow rings: unchanged');
});

test('prestige: circle sizes, unlocks and resets match on client and server', () => {
  assert.deepEqual([1, 25, 26, 50, 51, 75, 76, 100].map(progression.prestigeCircleSize), [10, 10, 15, 15, 20, 20, 25, 25]);
  const hits = (n: number) => Array(n).fill('CLEAN');
  const seq = [...hits(9), 'MISS', ...hits(10), ...hits(10), 'CLOSE', 'MISS', ...hits(25)];
  const server = progression.applyPrestige(0, seq as never);
  const client = web.applyPrestige(0, seq);
  // 9 hits then a miss: nothing. 10 + 10: levels 1, 2. A miss empties the circle. 25 hits: levels 3, 4 (+5 left over).
  assert.deepEqual(server.unlocked, [1, 2, 3, 4]);
  assert.deepEqual(client.unlocked, server.unlocked);
  assert.equal(client.level, 4);
  assert.equal(client.inCircle, 5);
  // Level 25 -> 26 needs 15 in a row; capped at 100.
  assert.deepEqual(progression.applyPrestige(25, hits(15) as never).unlocked, [26]);
  assert.equal(progression.applyPrestige(100, hits(50) as never).level, 100);
  assert.deepEqual(web.applyPrestige(99, hits(30)).unlocked, progression.applyPrestige(99, hits(30) as never).unlocked);
});

test('prestige: a PERFECT fills twice as much as a CLEAN or CLOSE; overflow carries over', () => {
  const P = (n: number) => Array(n).fill('PERFECT');
  const C = (n: number) => Array(n).fill('CLOSE');
  for (const impl of [web.applyPrestige, progression.applyPrestige]) {
    assert.deepEqual(impl(0, P(5) as never).unlocked, [1], '5 PERFECT = level 1');
    assert.deepEqual(impl(0, P(4) as never).unlocked, [], '4 PERFECT is not enough');
    assert.deepEqual(impl(0, C(10) as never).unlocked, [1], '10 CLOSE = level 1');
    assert.deepEqual(impl(0, [...P(3), ...C(4)] as never).unlocked, [1], 'a mix: 3x2 + 4x1 = 10');
    // 9 points then a PERFECT = 11: level 1 plus 1 point carried, so 9 more points reach level 2.
    assert.deepEqual(impl(0, [...C(9), 'PERFECT', ...C(9)] as never).unlocked, [1, 2]);
    assert.deepEqual(impl(0, [...P(4), 'MISS', ...P(4)] as never).unlocked, [], 'a miss empties the circle');
  }
});
