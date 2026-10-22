import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-123';
process.env.DEVICE_FINGERPRINT_PEPPER ??= 'test-pepper-test-pepper';

// @ts-expect-error — plain JS module shared with the browser client
const web = await import('../../Web/core.js');
const { generateSchedule, baseDurationForRating } = await import('../src/services/ringSchedule.ts');
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
    const windowMs = web.closeWindowMs(false, i);
    const off = offsetsMs[i]! * 1000;
    if (Math.abs(off) > windowMs * 1000) {
      taps.push(-1);
      clientVerdicts.push('MISS');
      resolveUs = closeUs + windowMs * 1000;
    } else {
      const tap = closeUs + off;
      taps.push(tap);
      clientVerdicts.push(web.classify(Math.abs(off), windowMs));
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
