import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocatePool } from '../src/services/prizes.js';

const e = (userId: string, points: number) => ({ userId, points: BigInt(points) });
const total = (r: ReturnType<typeof allocatePool>) => r.awards.reduce((a, w) => a + w.amountCents, 0) + r.unallocatedCents;

test('pool splits by points and every cent is accounted for', () => {
  const r = allocatePool([e('a', 300), e('b', 200), e('c', 100)], 60_000, 60_000, 0);
  assert.deepEqual(r.awards.map((w) => w.amountCents), [30_000, 20_000, 10_000]);
  assert.equal(r.unallocatedCents, 0);
});

test('cap: the excess goes to the other winners', () => {
  // a would get 90%, capped at 50%; b and c split the rest 2:1.
  const r = allocatePool([e('a', 900), e('b', 66), e('c', 33)], 10_000, 5_000, 0);
  assert.deepEqual(r.awards.map((w) => w.amountCents), [5_000, 3_333, 1_667]);
  assert.equal(total(r), 10_000);
});

test('cap: when everyone is capped the rest is unallocated (rolls over)', () => {
  const r = allocatePool([e('a', 5), e('b', 5)], 10_000, 1_000, 0);
  assert.deepEqual(r.awards.map((w) => w.amountCents), [1_000, 1_000]);
  assert.equal(r.unallocatedCents, 8_000);
});

test('minimum: tiny shares drop out and the rest share their part', () => {
  // With all three, c's share is 1% of $10 = 10c < 50c minimum; without c, a and b split $10.
  const r = allocatePool([e('a', 50), e('b', 49), e('c', 1)], 1_000, 1_000, 50);
  assert.deepEqual(r.awards.map((w) => [w.userId, w.amountCents]), [['a', 505], ['b', 495]]);
  assert.equal(total(r), 1_000);
});

test('ties are treated the same: both paid or neither', () => {
  // Two players tied at the bottom: paying both would leave each under the minimum, so neither is paid.
  const r = allocatePool([e('a', 100), e('b', 3), e('c', 3)], 1_000, 1_000, 40);
  assert.deepEqual(r.awards.map((w) => w.userId), ['a']);
  const tied = allocatePool([e('a', 10), e('b', 10), e('c', 5)], 1_000, 1_000, 0);
  assert.equal(tied.awards[0]!.rank, 1);
  assert.equal(tied.awards[1]!.rank, 1);
  assert.equal(tied.awards[2]!.rank, 3);
});

test('rounding: integer cents, never over the cap, sums to the pool', () => {
  const players = Array.from({ length: 997 }, (_, i) => e(`p${String(i).padStart(4, '0')}`, 1 + ((i * 7919) % 1000)));
  const r = allocatePool(players, 123_457, 2_000, 25);
  assert.equal(total(r), 123_457);
  for (const w of r.awards) {
    assert.ok(Number.isInteger(w.amountCents));
    assert.ok(w.amountCents <= 2_000 && w.amountCents >= 25);
  }
  // Higher points never get less.
  for (let i = 1; i < r.awards.length; i++) assert.ok(r.awards[i]!.amountCents <= r.awards[i - 1]!.amountCents + 1);
});

test('nothing to split', () => {
  assert.deepEqual(allocatePool([], 500, 500, 0), { awards: [], unallocatedCents: 500 });
  assert.deepEqual(allocatePool([e('a', 0)], 500, 500, 0), { awards: [], unallocatedCents: 500 });
  assert.deepEqual(allocatePool([e("a", 10)], 10, 50, 50).awards, []); // the whole pool is under the minimum
  assert.throws(() => allocatePool([e('a', 1)], 100, 10, 50));
});

test('a zero minimum still never awards 0 cents', () => {
  const r = allocatePool([e('a', 1_000_000), e('b', 1)], 100, 100, 0);
  assert.deepEqual(r.awards.map((w) => [w.userId, w.amountCents]), [['a', 100]]);
});
