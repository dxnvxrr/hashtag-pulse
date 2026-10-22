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

test('prestige: points per verdict are PERFECT 2, CLEAN 1.5, SO CLOSE 1 (in half-points 4/3/2)', () => {
  for (const impl of [web, progression]) {
    assert.deepEqual(['PERFECT', 'CLEAN', 'CLOSE', 'MISS'].map((v) => impl.prestigeHalfPoints(v as never)), [4, 3, 2, 0]);
  }
  const P = (n: number) => Array(n).fill('PERFECT');
  const C = (n: number) => Array(n).fill('CLOSE');
  const L = (n: number) => Array(n).fill('CLEAN');
  for (const impl of [web.applyPrestige, progression.applyPrestige]) {
    assert.deepEqual(impl(0, P(5) as never).unlocked, [1], '5 PERFECT = 10 points');
    assert.deepEqual(impl(0, C(10) as never).unlocked, [1], '10 SO CLOSE = 10 points');
    assert.deepEqual(impl(0, L(6) as never).unlocked, [], '6 CLEAN = 9 points');
    assert.deepEqual(impl(0, L(7) as never).unlocked, [1], '7 CLEAN = 10.5 points, 0.5 carried');
    assert.deepEqual(impl(0, [...P(2), ...L(2), ...C(3)] as never).unlocked, [1], 'mix: 4 + 3 + 3 = 10');
  }
  assert.equal(web.applyPrestige(0, L(7)).inCircle, 0.5);
});

test('prestige: on levels X1–X7 a miss halves the circle, rounding up to the next half point', () => {
  for (const impl of [web, progression]) {
    // Working toward level 1 (a forgiving level). Values in half-points: 8 -> 4 -> 2 -> 1 -> 0 points.
    assert.equal(impl.circleAfterMiss(16, 1), 8);
    assert.equal(impl.circleAfterMiss(8, 1), 4);
    assert.equal(impl.circleAfterMiss(4, 1), 2);
    assert.equal(impl.circleAfterMiss(2, 1), 0, '1 point -> 0');
    assert.equal(impl.circleAfterMiss(17, 1), 9, '8.5 -> 4.5 (4.25 rounded up)');
    assert.equal(impl.circleAfterMiss(3, 1), 2, '1.5 -> 1 (0.75 rounded up)');
    // Forgiving levels: 1–7, 11–17, ... 91–97. Strict: 8–10, 18–20, ... 98–100.
    assert.deepEqual([1, 7, 8, 10, 11, 17, 18, 20, 97, 98, 100].map(impl.missHalvesCircle), [true, true, false, false, true, true, false, false, true, false, false]);
    assert.equal(impl.circleAfterMiss(16, 8), 0, 'level 8: a miss empties the circle');
  }
  // Full sequence from the spec: 8/10, miss -> 4, miss -> 2, miss -> 1, miss -> 0.
  const seq = [...Array(4).fill('PERFECT'), 'MISS', 'MISS', 'MISS', 'MISS'];
  assert.equal(web.applyPrestige(0, seq).inCircle, 0);
  assert.equal(web.applyPrestige(0, seq.slice(0, 5)).inCircle, 4);
  assert.equal(web.applyPrestige(0, seq.slice(0, 7)).inCircle, 1);
  // 8 points, miss -> 4, then 3 PERFECT = 10 -> level 1 (would have needed 5 PERFECT after a full reset).
  const back = [...Array(4).fill('PERFECT'), 'MISS', ...Array(3).fill('PERFECT')];
  assert.deepEqual(progression.applyPrestige(0, back as never).unlocked, [1]);
  assert.deepEqual(web.applyPrestige(0, back).unlocked, [1]);
  // Level 8 is strict: 9 points then a miss empties it.
  assert.equal(web.applyPrestige(7, [...Array(9).fill('CLOSE'), 'MISS']).inCircle, 0);
  // Client and server agree on a long mixed sequence across a block boundary.
  const mixed = ['PERFECT', 'CLEAN', 'MISS', 'CLOSE', 'PERFECT', 'PERFECT', 'MISS', 'CLEAN', 'CLEAN', 'PERFECT', 'CLOSE', 'MISS', 'PERFECT', 'PERFECT', 'PERFECT'];
  for (const start of [0, 6, 7, 9, 16, 97]) {
    assert.deepEqual(web.applyPrestige(start, mixed).unlocked, progression.applyPrestige(start, mixed as never).unlocked, `start ${start}`);
  }
});

test('music: every theme composes a full 4-bar loop that resolves', async () => {
  // @ts-expect-error — plain JS module shared with the browser client
  const music = await import('../../Web/music.js');
  const names = new Set();
  for (let i = 0; i <= 10; i++) {
    const t = music.composeTheme(i);
    assert.equal(t.steps.length, 32);
    assert.ok(t.steps.filter((s: { lead: number | null }) => s.lead !== null).length >= 12, `theme ${i} has a melody`);
    names.add(t.name);
  }
  assert.equal(names.size, 11);
  assert.deepEqual([0, 1, 10, 11, 20, 99, 100].map(music.themeIndexFor), [0, 0, 0, 1, 1, 9, 10]);
});
