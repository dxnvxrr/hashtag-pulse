import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgresql://u:p@localhost:5432/db';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_ACCESS_SECRET ??= 'test-secret-test-secret-test-secret-123';
process.env.DEVICE_FINGERPRINT_PEPPER ??= 'test-pepper-test-pepper';

const { generateSchedule, Mulberry32 } = await import('../src/services/ringSchedule.ts');
const { evaluateRun, canonicalString } = await import('../src/services/antiCheat.service.ts');

/** Golden vectors — Client/Assets/Scripts/Core/RingSchedule.cs must produce identical values. */
test('mulberry32 golden vector', () => {
  const rng = new Mulberry32(12345);
  assert.deepEqual([rng.nextUint(), rng.nextUint(), rng.nextUint()], [4207900869, 1317490944, 2079646450]);
});

test('schedule golden vector', () => {
  const s = generateSchedule(12345, 2000, 16).map((r) => [r.durationMs, r.gapMs, r.archetype, r.drift]);
  assert.deepEqual(s, [
    [1882, 0, 0, 0], [1994, 339, 0, 0], [2073, 333, 0, 0], [1854, 378, 0, 0],
    [1890, 479, 0, 0], [1826, 380, 0, 0], [1857, 470, 0, 0], [1927, 466, 0, 0],
    [2005, 500, 0, 0], [1858, 526, 1, -1], [1917, 454, 0, 0], [1736, 438, 1, 1],
    [1794, 383, 0, 0], [1754, 409, 0, 0], [1918, 439, 0, 0], [1711, 404, 0, 0],
  ]);
});

/** Builds taps that land exactly `offsetUs` from each ring's close moment. */
function perfectTaps(seed: number, base: number, n: number, offsetUs: (i: number) => number): number[] {
  const rings = generateSchedule(seed, base, n);
  const taps: number[] = [];
  let resolve = 0;
  for (let i = 0; i < n; i++) {
    const spawn = i === 0 ? 0 : resolve + rings[i]!.gapMs * 1000;
    const tap = spawn + rings[i]!.durationMs * 1000 + offsetUs(i);
    taps.push(tap);
    resolve = tap;
  }
  return taps;
}

const base = { seed: 777, baseDurationMs: 2000, ftue: false, maxMisses: 3, maxRings: 500, slowMoRings: [] as number[] };

test('verdict windows', () => {
  const offsets = [0, 5_000, 6_000, 15_000, 16_000, -40_000];
  const r = evaluateRun({ ...base, tapsUs: perfectTaps(777, 2000, offsets.length, (i) => offsets[i]!) });
  assert.equal(r.valid, true);
  assert.deepEqual(r.verdicts, ['PERFECT', 'PERFECT', 'CLEAN', 'CLEAN', 'CLOSE', 'CLOSE']);
  assert.equal(r.bestDeltaUs, 0);
});

test('tap before spawn is rejected', () => {
  const taps = perfectTaps(777, 2000, 3, () => 0);
  taps[1] = taps[0]! + 1; // inside the gap, before ring 1 spawns
  assert.equal(evaluateRun({ ...base, tapsUs: taps }).rejectReason, 'tap_before_spawn');
});

test('rings after the third miss are rejected', () => {
  assert.equal(evaluateRun({ ...base, tapsUs: [-1, -1, -1, -1] }).rejectReason, 'rings_after_game_over');
  assert.equal(evaluateRun({ ...base, tapsUs: [-1, -1, -1] }).valid, true);
});

test('bot consistency is flagged', () => {
  const r = evaluateRun({ ...base, tapsUs: perfectTaps(777, 2000, 60, (i) => (i % 2 ? 1_000 : -1_000)) });
  assert.ok(r.flags.includes('inhuman_consistency'));
});

test('human-like spread is not flagged', () => {
  const r = evaluateRun({ ...base, tapsUs: perfectTaps(777, 2000, 60, (i) => ((i * 7919) % 31_000) - 15_000) });
  assert.equal(r.flags.length, 0);
});

test('slow-mo stretches the ring 2.5x', () => {
  const rings = generateSchedule(777, 2000, 1);
  const r = evaluateRun({ ...base, slowMoRings: [0], tapsUs: [rings[0]!.durationMs * 2500] });
  assert.deepEqual(r.verdicts, ['PERFECT']);
});

test('canonical string format', () => {
  assert.equal(
    canonicalString('post', '/v1/runs/submit', '1700000000000', 'abcdefghijklmnop', '{}'),
    'POST\n/v1/runs/submit\n1700000000000\nabcdefghijklmnop\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  );
});
